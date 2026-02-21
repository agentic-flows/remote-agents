/**
 * Orchestrator — Voice + Text chat agent DO for managing remote coding agents.
 *
 * Extends VoiceAgent from core/ which provides the full voice pipeline:
 *   - STT (Deepgram Flux) + TTS (Cloudflare Aura) lifecycle
 *   - Flux state machine (StartOfTurn, EagerEndOfTurn, TurnResumed, EndOfTurn)
 *   - LLM inference with streaming into TTS
 *   - Conversation history, echo cancellation, barge-in
 *
 * This class adds:
 *   - Browser WebSocket transport (binary PCM frames, voice:start/stop control)
 *   - Text chat via @callable doChat RPC (same tools, shared history)
 *   - All Orchestrator tools (container lifecycle, session mgmt, workspace, lb)
 *
 * Pattern matches MyPhoneAgent from DREAM-agents — same VoiceAgent base,
 * different transport (browser WebSocket instead of Twilio media stream).
 */

import { getSandbox } from '@cloudflare/sandbox';
import { type Connection, callable } from 'agents';
import { VoiceAgent } from '../core/voice-agent/voice.js';
import type { VoiceAgentState } from '../core/voice-agent/voice.js';
import type { AnyToolDefinition } from '../core/infer/tools/types.js';
import type { Message } from '../core/infer/inferutils/common.js';
import { infer } from '../core/infer/inferutils/core.js';
import { WORK_DIR, DEFAULT_MODEL, AGENT_PROFILES, getClient } from './config.js';
import { setupWorkspace, saveWorkspace, restoreWorkspace, resolveWorkspaceKey } from './workspace.js';
import { Sandbox } from './sandbox.js';
import type { Config } from '@opencode-ai/sdk';

// =============================================================================
// TYPES
// =============================================================================

interface OrchestratorState extends VoiceAgentState {
  initialized: boolean;
  messageCount: number;
  lastActivity: string | null;
}

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `You are the Orchestrator — a remote coding agent manager running on Cloudflare Workers.

You manage coding agents that run inside Cloudflare Containers. Each container runs opencode serve (an AI coding agent) that can write code, run commands, create PRs, and more.

## Your Capabilities

You have tools to:
- **Dispatch issues**: Set up a container with a cloned repo, lb integration, and send it an issue to work on
- **Kickoff tasks**: Send raw prompts to containers (no lb integration needed)
- **Monitor sessions**: Check session status, read messages, list all sessions
- **Send follow-ups**: Send additional instructions to running agents
- **Execute commands**: Run shell commands directly in the container
- **Read files**: Read files from the container workspace
- **Manage workspaces**: Save/restore/list/delete R2 workspaces
- **Track issues**: Use lb to view ready issues, show issue details, list/sync issues

## How to Use Your Tools

1. When the user wants to work on an issue: use \`lb_ready\` to find work, then \`dispatch_issue\` to launch an agent
2. When the user wants a raw task: use \`kickoff\` with a prompt
3. To check progress: use \`check_session\` or \`list_sessions\`
4. To send more instructions: use \`send_message\`
5. To debug: use \`exec_command\` to run shell commands or \`read_file\` to inspect code

## Important Notes

- Containers take ~30 seconds to start. Be patient after dispatch/kickoff.
- Sessions are async — after dispatching, the agent works independently.
- Use \`check_session\` to poll for completion.
- The container has git, gh CLI, lb CLI, and opencode pre-installed.
- All agents use the free opencode/big-pickle model by default.
- Workspaces can be persisted to R2 between sessions.

Be concise and helpful. Report tool results clearly. If a tool fails, explain why and suggest alternatives.`;

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export class Orchestrator extends VoiceAgent<Env, OrchestratorState> {
  // Voice is active when browser has mic open
  private voiceActive = false;

  initialState: OrchestratorState = {
    callSid: null,
    callerPhone: null,
    initialized: false,
    messageCount: 0,
    lastActivity: null,
  };

  // ---------------------------------------------------------------------------
  // VoiceAgent hooks
  // ---------------------------------------------------------------------------

  protected getGreeting(): string {
    // Not used — browser transport doesn't auto-greet (unlike Twilio).
    // Abstract method requires implementation.
    return '';
  }

  protected getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  protected override getTools(): AnyToolDefinition[] {
    return this.buildTools();
  }

  // Browser needs linear16 at 24kHz (not Twilio mulaw 8kHz)
  protected override getTTSEncoding(): string { return 'linear16'; }
  protected override getTTSSampleRate(): string { return '24000'; }

  // ---------------------------------------------------------------------------
  // Browser WebSocket transport (like MyPhoneAgent's Twilio transport)
  // ---------------------------------------------------------------------------

  /**
   * Handle incoming WebSocket messages. The Agent SDK wrapper calls this
   * after handling protocol messages (RPC, state updates).
   *
   * Binary frames = raw PCM16 16kHz audio from browser mic.
   * JSON voice:start/stop = voice mode control.
   */
  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // Binary frames = raw PCM audio from browser mic
    if (message instanceof ArrayBuffer) {
      if (this.voiceActive) {
        this.sendAudioToSTT(message);
      }
      return;
    }

    // Try parsing as voice control message
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        if (data.type === 'voice:start') {
          await this.startBrowserVoice();
          return;
        }
        if (data.type === 'voice:stop') {
          await this.stopBrowserVoice();
          return;
        }
      } catch {
        // Not JSON or not a voice message — fall through
      }
    }

    // Everything else: SDK already handled RPC/state before calling us
  }

  /**
   * Start voice mode for browser transport.
   * Mirrors MyPhoneAgent.onConnect: init pipeline with transport callbacks.
   */
  private async startBrowserVoice(): Promise<void> {
    if (this.voiceActive) return;
    console.log('[Voice] Starting browser voice mode');

    const ai = (this.env as any).AI as Ai | undefined;
    if (!ai) {
      this.broadcast(JSON.stringify({ type: 'voice:error', error: 'AI binding not available' }));
      return;
    }

    // Override TTS config for browser (linear16 24kHz, not Twilio mulaw 8kHz)
    // VoiceAgent.initVoicePipeline creates TTS internally, but we need to
    // configure it for browser before calling. Set the env overrides.
    // Actually — we need to configure the TTS encoding. The VoiceAgent creates
    // TTS with default Twilio mulaw encoding. For browser we need linear16/24kHz.
    // We'll override by setting properties before initVoicePipeline.

    try {
      await this.initVoicePipeline({
        onAudioChunk: (chunk: Uint8Array) => {
          // Copy to clean ArrayBuffer to avoid byteOffset issues
          const buf = new ArrayBuffer(chunk.byteLength);
          new Uint8Array(buf).set(chunk);
          this.broadcast(buf);
        },

        onTTSFlushed: () => {
          this.broadcast(JSON.stringify({ type: 'voice:tts:done' }));
          this.isSpeaking = false;
        },

        onBargeIn: () => {
          // Tell browser to flush its audio playback queue
          this.broadcast(JSON.stringify({ type: 'voice:tts:clear' }));
        },
      });
    } catch (e) {
      console.error('[Voice] Pipeline init failed:', e);
      this.broadcast(JSON.stringify({ type: 'voice:error', error: `Voice init failed: ${e}` }));
      return;
    }

    this.voiceActive = true;
    this.broadcast(JSON.stringify({ type: 'voice:started' }));
    console.log('[Voice] Browser voice mode active');
  }

  /**
   * Stop voice mode. Mirrors cleanup in MyPhoneAgent.cleanupAll.
   */
  private async stopBrowserVoice(): Promise<void> {
    console.log('[Voice] Stopping browser voice mode');
    this.voiceActive = false;
    this.cleanupVoicePipeline();
    this.broadcast(JSON.stringify({ type: 'voice:stopped' }));
  }

  // ---------------------------------------------------------------------------
  // Text chat — @callable RPC (lifted from ChatAgent)
  // ---------------------------------------------------------------------------

  @callable({ description: 'Send a chat message (streaming via WebSocket broadcast)' })
  async doChat(input: { message: string }): Promise<{ id: string; role: 'assistant'; content: string; timestamp: string }> {
    const message = typeof input === 'string' ? (input as any) : input.message;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Build messages from shared history (voice + text share the same history)
    const systemMsg: Message = { role: 'system', content: SYSTEM_PROMPT };
    this.history.push({ role: 'user', content: message });

    // Truncate to avoid message limits (keep last 80)
    if (this.history.length > 80) {
      this.history = this.history.slice(-80);
    }

    const messages: Message[] = [systemMsg, ...this.history];

    // Broadcast stream start
    this.broadcast(JSON.stringify({ type: 'chat:stream:start', id: msgId }));

    const tools = this.buildTools();

    const result = await infer({
      env: this.env,
      metadata: { agentId: 'orchestrator', userId: 'chat-user' },
      actionKey: 'testModelConfig',
      messages,
      modelName: 'openai/gpt-4.1-nano',
      tools,
      maxTokens: 8192,
      temperature: 0.3,
      stream: {
        chunk_size: 1,
        onChunk: (chunk: string) => {
          this.broadcast(JSON.stringify({ type: 'chat:stream:chunk', id: msgId, content: chunk }));
        },
      },
    });

    const assistantContent = result.string || '';

    // Broadcast stream end
    this.broadcast(JSON.stringify({ type: 'chat:stream:end', id: msgId, content: assistantContent }));

    // Update shared history
    if (result.toolCallContext?.messages) {
      for (const msg of result.toolCallContext.messages) {
        this.history.push(msg);
      }
    }
    this.history.push({ role: 'assistant', content: assistantContent });

    // Cap history
    if (this.history.length > 80) {
      this.history = this.history.slice(-80);
    }

    this.setState({
      ...this.state,
      messageCount: (this.state.messageCount || 0) + 1,
      lastActivity: new Date().toISOString(),
    });

    return { id: msgId, role: 'assistant', content: assistantContent, timestamp: new Date().toISOString() };
  }

  @callable({ description: 'Get conversation history' })
  getHistory() {
    return this.history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({
        id: `msg_${i}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        timestamp: this.state.lastActivity || new Date().toISOString(),
      }));
  }

  @callable({ description: 'Clear conversation history' })
  clearHistory() {
    this.history = [];
    this.setState({ ...this.state, messageCount: 0 });
    return { cleared: true };
  }

  @callable({ description: 'Health check' })
  ping() {
    return {
      ok: true,
      messageCount: this.state.messageCount || 0,
      voiceActive: this.voiceActive,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private getSandbox(): ReturnType<typeof getSandbox> {
    return getSandbox(this.env.Sandbox, 'opencode');
  }

  private buildTools(): AnyToolDefinition[] {
    const sandbox = this.getSandbox();
    const env = this.env;

    return [
      // =====================================================================
      // CONTAINER LIFECYCLE
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'dispatch_issue',
          description: 'Dispatch a Linear issue to a remote coding agent. Sets up a container with the repo cloned, lb configured, and sends the issue as a prompt. The agent will implement the issue, create a PR, and update the issue status.',
          parameters: {
            type: 'object',
            properties: {
              issueId: { type: 'string', description: 'Linear issue ID (e.g. "AGE-42")' },
              repo: { type: 'string', description: 'Git repo URL (e.g. "https://github.com/org/repo.git")' },
              profile: { type: 'string', description: 'Agent profile: coder, researcher, refiner, reviewer. Default: coder' },
            },
            required: ['issueId', 'repo'],
          },
        },
        implementation: async (args: { issueId: string; repo: string; profile?: string }) => {
          const issueId = args.issueId.toUpperCase();
          const branch = `${issueId}-remote`;

          const profile = args.profile ? AGENT_PROFILES[args.profile] : undefined;
          if (args.profile && !profile) {
            return { error: `Unknown profile "${args.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` };
          }

          await setupWorkspace(sandbox, env, { repo: args.repo, branch, setupLb: true });

          const issueResult = await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb show ${issueId} 2>&1`,
          );
          const issueDescription = issueResult.stdout || '';
          if (!issueDescription || issueDescription.includes('not found')) {
            return { error: `Issue ${issueId} not found`, raw: issueDescription };
          }

          await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb update ${issueId} --status in_progress 2>&1 || true`,
          );

          const mergedMcp = { ...profile?.mcp };
          const { client } = await getClient(sandbox, env, mergedMcp);
          const session = await client.session.create({ title: `${issueId} — Remote Agent`, directory: WORK_DIR });
          if (!session.data) throw new Error(`Failed to create session: ${JSON.stringify(session)}`);

          const prompt = buildDispatchPrompt(issueId, branch, issueDescription, env);
          const model = profile?.model || DEFAULT_MODEL;
          const systemPrompt = profile?.system;
          const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

          await client.session.promptAsync({
            sessionID: session.data.id,
            directory: WORK_DIR,
            model,
            parts: [{ type: 'text', text: fullPrompt }],
          });

          await (sandbox as unknown as Sandbox).logSession({
            sessionId: session.data.id,
            issueId,
            prompt: fullPrompt,
            model,
            repo: args.repo,
            branch,
            workspaceKey: `issue/${issueId}`,
          });

          return { sessionId: session.data.id, issueId, branch, status: 'dispatched', model };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'kickoff',
          description: 'Send a raw prompt to a remote agent. No lb integration — just a container with opencode. Optionally clone a repo or create a named workspace.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The prompt/instructions to send to the agent' },
              repo: { type: 'string', description: 'Git repo URL to clone (optional)' },
              project: { type: 'string', description: 'Project name — auto-creates a GitHub repo under agentic-flows/ (optional)' },
              workspace: { type: 'string', description: 'Named workspace — persists across sessions via R2 (optional)' },
              branch: { type: 'string', description: 'Git branch to checkout (optional)' },
              profile: { type: 'string', description: 'Agent profile: coder, researcher, refiner, reviewer (optional)' },
            },
            required: ['text'],
          },
        },
        implementation: async (args: {
          text: string;
          repo?: string;
          project?: string;
          workspace?: string;
          branch?: string;
          profile?: string;
        }) => {
          const profile = args.profile ? AGENT_PROFILES[args.profile] : undefined;
          if (args.profile && !profile) {
            return { error: `Unknown profile "${args.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` };
          }

          const repoUrl = await setupWorkspace(sandbox, env, {
            repo: args.repo,
            project: args.project,
            branch: args.branch,
            workspace: args.workspace,
            setupLb: false,
          });

          const mergedMcp = { ...profile?.mcp };
          const { client } = await getClient(sandbox, env, mergedMcp);
          const session = await client.session.create({
            title: args.workspace ? `Workspace: ${args.workspace}` : args.project ? `Project: ${args.project}` : 'Remote Agent',
            directory: WORK_DIR,
          });
          if (!session.data) throw new Error(`Failed to create session: ${JSON.stringify(session)}`);

          let promptText = args.text;
          if (repoUrl) {
            promptText += `\n\n## Persistence\n\nYour workspace is backed by a GitHub repo: ${repoUrl}\nWhen done, commit and push: \`git add -A && git commit -m "description" && git push\``;
          } else if (args.workspace) {
            promptText += `\n\n## Persistence\n\nYour workspace "${args.workspace}" persists via R2. No git push needed.`;
          }

          const systemPrompt = profile?.system;
          const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${promptText}` : promptText;
          const model = profile?.model || DEFAULT_MODEL;

          await client.session.promptAsync({
            sessionID: session.data.id,
            directory: WORK_DIR,
            model,
            parts: [{ type: 'text', text: fullPrompt }],
          });

          const workspaceKey = args.workspace ? `named/${args.workspace}` : undefined;
          await (sandbox as unknown as Sandbox).logSession({
            sessionId: session.data.id,
            prompt: fullPrompt,
            model,
            repo: repoUrl ?? undefined,
            workspaceKey,
          });

          return { sessionId: session.data.id, status: 'kicked off', model, repo: repoUrl, workspace: args.workspace ?? null };
        },
      },

      // =====================================================================
      // SESSION MANAGEMENT
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'check_session',
          description: 'Check the status of a running session. Returns whether the agent is busy or idle, and recent messages.',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID to check' },
            },
            required: ['sessionId'],
          },
        },
        implementation: async (args: { sessionId: string }) => {
          try {
            const { client } = await getClient(sandbox, env);
            const [session, status, messages] = await Promise.all([
              client.session.get({ sessionID: args.sessionId, directory: WORK_DIR }),
              client.session.status({ directory: WORK_DIR }),
              client.session.messages({ sessionID: args.sessionId, directory: WORK_DIR }),
            ]);

            const statusData = status.data ?? {};
            const sessionBusy = statusData[args.sessionId]?.type === 'busy';
            const liveMessages = messages.data ?? [];

            if (!sessionBusy && liveMessages.length > 0) {
              try {
                await (sandbox as unknown as Sandbox).saveMessages(args.sessionId, liveMessages);
                await (sandbox as unknown as Sandbox).updateSessionStatus(args.sessionId, 'completed');
              } catch { /* non-fatal */ }
            }

            const recentMessages = liveMessages.slice(-5).map((m: any) => ({
              role: m.role ?? m.type ?? 'unknown',
              content: typeof m.content === 'string' ? m.content?.slice(0, 500) :
                Array.isArray(m.parts) ? m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').slice(0, 500) : null,
            }));

            return {
              source: 'live',
              session: session.data ?? null,
              busy: sessionBusy,
              messageCount: liveMessages.length,
              recentMessages,
            };
          } catch {
            try {
              const log = await (sandbox as unknown as Sandbox).getSessionLog(args.sessionId);
              const saved = await (sandbox as unknown as Sandbox).getSessionMessages(args.sessionId);
              return { source: 'persisted', session: log, messageCount: saved.length, busy: false };
            } catch {
              return { error: `Session ${args.sessionId} not found (container unavailable)` };
            }
          }
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'send_message',
          description: 'Send a follow-up message to a running session. The agent will process it asynchronously.',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID to message' },
              text: { type: 'string', description: 'The message to send' },
            },
            required: ['sessionId', 'text'],
          },
        },
        implementation: async (args: { sessionId: string; text: string }) => {
          const { client } = await getClient(sandbox, env);
          await client.session.promptAsync({
            sessionID: args.sessionId,
            directory: WORK_DIR,
            model: DEFAULT_MODEL,
            parts: [{ type: 'text', text: args.text }],
          });
          return { status: 'sent', sessionId: args.sessionId };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'list_sessions',
          description: 'List all sessions — both persisted (from DO SQLite) and live (from container).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const persisted = await (sandbox as unknown as Sandbox).getSessions();

          let live: any[] = [];
          try {
            const { client } = await getClient(sandbox, env);
            const sessions = await client.session.list({ directory: WORK_DIR });
            live = sessions.data ?? [];
          } catch { /* container dead */ }

          return { persisted, live };
        },
      },

      // =====================================================================
      // CONTAINER OPERATIONS
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'exec_command',
          description: 'Execute a shell command in the container. Useful for debugging, checking git status, running tests, etc.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to run' },
            },
            required: ['command'],
          },
        },
        implementation: async (args: { command: string }) => {
          const result = await sandbox.exec(args.command);
          return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            exitCode: result.exitCode ?? 0,
          };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file from the container workspace. Returns file content or directory listing.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace root (e.g. "src/index.ts")' },
            },
            required: ['path'],
          },
        },
        implementation: async (args: { path: string }) => {
          if (!args.path || args.path.includes('..')) {
            return { error: 'Invalid file path' };
          }
          const fullPath = `${WORK_DIR}/${args.path}`;
          const checkResult = await sandbox.exec(`test -d "${fullPath}" && echo DIR || test -f "${fullPath}" && echo FILE || echo NOTFOUND`);
          const type = checkResult.stdout?.trim();

          if (type === 'NOTFOUND') return { error: `File not found: ${args.path}` };
          if (type === 'DIR') {
            const ls = await sandbox.exec(`ls -la "${fullPath}"`);
            return { type: 'directory', path: args.path, listing: ls.stdout };
          }

          const result = await sandbox.readFile(fullPath);
          return { type: 'file', path: args.path, content: result.content };
        },
      },

      // =====================================================================
      // WORKSPACE MANAGEMENT
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'save_workspace',
          description: 'Save the current container workspace to R2 for persistence.',
          parameters: {
            type: 'object',
            properties: {
              workspace: { type: 'string', description: 'Named workspace key (e.g. "my-project")' },
              sessionId: { type: 'string', description: 'Session ID (alternative to workspace name)' },
              issueId: { type: 'string', description: 'Issue ID (alternative to workspace name)' },
            },
            required: [],
          },
        },
        implementation: async (args: { workspace?: string; sessionId?: string; issueId?: string }) => {
          const key = resolveWorkspaceKey(args);
          const result = await saveWorkspace(sandbox, env, key);
          return { saved: true, key: result.key, size: result.size, sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB` };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'list_workspaces',
          description: 'List all saved workspaces in R2.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const list = await env.R2_BUCKET.list({ prefix: 'workspaces/' });
          return list.objects.map((obj: any) => ({
            key: obj.key,
            name: obj.key.replace('workspaces/', '').replace('.tar.gz', ''),
            size: obj.size,
            sizeHuman: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
            uploaded: obj.uploaded.toISOString(),
          }));
        },
      },

      // =====================================================================
      // LB (LINEAR ISSUE TRACKING)
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'lb_ready',
          description: 'List issues that are ready to work on (todo_refined + todo_bug, unblocked).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const result = await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb ready 2>&1`,
          );
          return { output: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'lb_show',
          description: 'Show full details for a Linear issue — description, status, relations.',
          parameters: {
            type: 'object',
            properties: {
              issueId: { type: 'string', description: 'Issue ID (e.g. "AGE-42")' },
            },
            required: ['issueId'],
          },
        },
        implementation: async (args: { issueId: string }) => {
          const result = await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb show ${args.issueId} 2>&1`,
          );
          return { output: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'lb_list',
          description: 'List all issues, optionally filtered by status or label.',
          parameters: {
            type: 'object',
            properties: {
              status: { type: 'string', description: 'Filter by status (e.g. "in_progress", "todo_refined")' },
              label: { type: 'string', description: 'Filter by label' },
            },
            required: [],
          },
        },
        implementation: async (args: { status?: string; label?: string }) => {
          let cmd = `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb list`;
          if (args.status) cmd += ` --status ${args.status}`;
          if (args.label) cmd += ` --label ${args.label}`;
          const result = await sandbox.exec(`${cmd} 2>&1`);
          return { output: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'lb_sync',
          description: 'Sync issues with Linear — pulls latest and pushes any local changes.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const result = await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb sync 2>&1`,
          );
          return { output: result.stdout ?? '', stderr: result.stderr ?? '' };
        },
      },
    ];
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function buildDispatchPrompt(
  issueId: string,
  branch: string,
  issueDescription: string,
  _env: Env,
): string {
  return `You are a remote coding agent working on issue ${issueId}.
You are on branch \`${branch}\` in /home/user/workspace.

## Your Issue

${issueDescription}

## Instructions

1. Read the issue carefully. Implement what is described.
2. Make your changes in the workspace. Write clean, well-structured code.
3. Test your changes if there are tests available (check package.json scripts).
4. When you are done coding:
   a. Stage and commit your changes with a descriptive commit message referencing ${issueId}.
   b. Push the branch: \`git push -u origin ${branch}\`
   c. Create a PR: \`gh pr create --title "${issueId}: <short summary>" --body "<description of changes>" --base main\`
   d. Update the issue status: \`LINEAR_API_KEY=$LINEAR_API_KEY lb update ${issueId} --status in_review\`
5. If you discover bugs or issues while working, create them immediately:
   \`LINEAR_API_KEY=$LINEAR_API_KEY lb create "Found: <description>" --discovered-from ${issueId} -d "Details..."\`

## Environment

- Git is configured with author identity.
- GitHub CLI (\`gh\`) is authenticated — you can push and create PRs.
- \`lb\` is available for issue tracking. LINEAR_API_KEY is set in the environment.
- You are on branch \`${branch}\`, based off \`main\`.

## Important

- Do NOT ask for clarification. Work with what you have.
- Do NOT skip steps. Commit, push, create PR, and update the issue status.
- Be thorough. The issue description contains your acceptance criteria.
`;
}
