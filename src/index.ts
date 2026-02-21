/**
 * Remote Agents Worker
 *
 * Spins up a Sandbox container running opencode serve, then:
 *
 * 1. Web UI    — GET  /                        → opencode web experience
 * 2. Dispatch  — POST /api/dispatch             → dispatch an lb issue to a remote agent
 * 3. Kickoff   — POST /api/kickoff              → raw prompt (no lb integration)
 * 4. Status    — GET  /api/session/:id          → check session status
 * 5. Messages  — GET  /api/session/:id/messages → conversation history
 * 6. Prompt    — POST /api/session/:id/prompt   → send follow-up (async)
 * 7. Exec      — POST /api/exec                 → run command in container (debug)
 * 8. Sessions  — GET  /api/sessions             → list all sessions
 * 9. Profiles  — GET  /api/profiles             → list available agent profiles
 * 10. Ws Save  — POST /api/workspace/save       → save workspace to R2
 * 11. Ws List  — GET  /api/workspace/list       → list saved workspaces
 * 12. Ws Del   — DELETE /api/workspace/:name    → delete a named workspace
 * 13. Ws File  — GET  /api/workspace/file/*     → read file from workspace
 *
 * Based on the sandbox-sdk opencode-remote reference example.
 *
 * IMPORTANT: The sandbox SDK uses @opencode-ai/sdk v2 client which has
 * flat parameters (sessionID, directory, parts, model) — NOT nested
 * path/query/body objects.
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
} from '@cloudflare/sandbox/opencode';
import type { Config } from '@opencode-ai/sdk';

import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';

/**
 * Extended Sandbox that persists session logs to DO SQLite.
 * Sessions survive container hibernation/restart.
 */
export class Sandbox extends BaseSandbox<Env> {
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Create session log tables (idempotent)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_log (
        session_id TEXT PRIMARY KEY,
        issue_id TEXT,
        prompt TEXT,
        model_provider TEXT,
        model_id TEXT,
        repo TEXT,
        branch TEXT,
        workspace_key TEXT,
        status TEXT DEFAULT 'dispatched',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Add workspace_key column if it doesn't exist (migration for existing DOs)
    try {
      ctx.storage.sql.exec(`ALTER TABLE session_log ADD COLUMN workspace_key TEXT`);
    } catch {
      // Column already exists — ignore
    }
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        error TEXT,
        captured_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES session_log(session_id)
      )
    `);
  }

  /** Log a new session dispatch */
  logSession(data: {
    sessionId: string;
    issueId?: string;
    prompt: string;
    model: { providerID: string; modelID: string };
    repo?: string;
    branch?: string;
    workspaceKey?: string;
  }) {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO session_log (session_id, issue_id, prompt, model_provider, model_id, repo, branch, workspace_key, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched')`,
      data.sessionId,
      data.issueId ?? null,
      data.prompt,
      data.model.providerID,
      data.model.modelID,
      data.repo ?? null,
      data.branch ?? null,
      data.workspaceKey ?? null,
    );
  }

  /** Update session status */
  updateSessionStatus(sessionId: string, status: string) {
    this.ctx.storage.sql.exec(
      `UPDATE session_log SET status = ?, updated_at = datetime('now') WHERE session_id = ?`,
      status,
      sessionId,
    );
  }

  /** Save captured messages for a session */
  saveMessages(sessionId: string, messages: any[]) {
    for (const msg of messages) {
      // Extract useful info from the message based on its shape
      const role = msg.role ?? msg.type ?? 'unknown';
      let content: string | null = null;
      let toolName: string | null = null;
      let toolInput: string | null = null;
      let toolOutput: string | null = null;
      let error: string | null = null;

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.parts)) {
        // v2 SDK format with parts array
        content = msg.parts
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n');
        for (const part of msg.parts) {
          if (part.type === 'tool-invocation' || part.type === 'tool-call') {
            toolName = part.toolName ?? part.name ?? null;
            toolInput = typeof part.args === 'string' ? part.args : JSON.stringify(part.args ?? null);
          }
          if (part.type === 'tool-result') {
            toolOutput = typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? null);
          }
        }
      }

      if (msg.error) {
        error = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error);
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO session_messages (session_id, role, content, tool_name, tool_input, tool_output, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        role,
        content,
        toolName,
        toolInput,
        toolOutput,
        error,
      );
    }
  }

  /** Get all logged sessions */
  getSessions(): any[] {
    return this.ctx.storage.sql.exec(
      `SELECT * FROM session_log ORDER BY created_at DESC`,
    ).toArray();
  }

  /** Get a specific session log */
  getSessionLog(sessionId: string): any {
    try {
      return this.ctx.storage.sql.exec(
        `SELECT * FROM session_log WHERE session_id = ?`,
        sessionId,
      ).one();
    } catch {
      return null;
    }
  }

  /** Get saved messages for a session */
  getSessionMessages(sessionId: string): any[] {
    return this.ctx.storage.sql.exec(
      `SELECT * FROM session_messages WHERE session_id = ? ORDER BY id ASC`,
      sessionId,
    ).toArray();
  }
}

const WORK_DIR = '/home/user/workspace';

// Free models available via opencode's built-in provider (no API key needed):
//   opencode/big-pickle       — Anthropic-based, 200k ctx, reasoning + tools
//   opencode/glm-5-free       — GLM-5, 200k ctx, reasoning + tools
//   opencode/gpt-5-nano       — GPT-5 Nano, 400k ctx, reasoning + tools
//   opencode/minimax-m2.5-free — MiniMax, tools
//   opencode/trinity-large-preview-free — Trinity, tools
const DEFAULT_MODEL = {
  providerID: 'opencode',
  modelID: 'big-pickle',
};

// The sandbox SDK uses @opencode-ai/sdk v2 client at runtime (flat params),
// but TypeScript resolves the v1 types from the package root. We use `any`
// for the client to avoid type mismatches.
type SdkClient = any;

// ---------------------------------------------------------------------------
// Agent Profiles — named bundles of model + system prompt + MCP servers.
// Select via `"profile": "researcher"` in dispatch/kickoff request body.
// Profile settings are defaults that can be overridden by explicit params.
// ---------------------------------------------------------------------------
interface AgentProfile {
  model: { providerID: string; modelID: string };
  system?: string;
  mcp?: Config['mcp'];
}

const AGENT_PROFILES: Record<string, AgentProfile> = {
  // Default coder — no special system prompt, relies on AGENTS.md from repo
  coder: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
  },

  // Research agent — optimized for web research, summarization, and analysis
  researcher: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are a research agent. Your primary job is to gather information, analyze it, and produce well-structured research reports.

## Tools & Approach

- Use web search and fetch tools aggressively to gather information from multiple sources.
- Cross-reference claims across sources. Note disagreements or uncertainty.
- Cite your sources with URLs.
- Structure your output with clear sections, headings, and bullet points.
- When writing files, use markdown format with proper frontmatter.

## Output

Always save your research to files in the workspace:
- Main report: \`research.md\` or \`<topic>.md\`
- Raw notes: \`notes/\` directory for supporting material
- Data: \`data/\` directory for any structured data (JSON, CSV)

When done, commit and push all files to preserve your work.`,
    mcp: {
      // Researcher gets all default MCP servers plus any extras
    },
  },

  // Refiner agent — reads issues and adds implementation details
  refiner: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are an issue refinement agent. Your job is to take rough issue descriptions and add detailed implementation plans.

## Process

1. Read the issue description carefully.
2. Explore the codebase to understand the architecture and patterns.
3. Add to the issue description:
   - Technical approach with specific files to modify
   - Step-by-step implementation plan
   - Acceptance criteria (testable, specific)
   - Dependencies and risks
   - Estimated complexity

## Style

- Be specific: name files, functions, line numbers.
- Be practical: focus on what to change, not theory.
- Be thorough: cover edge cases and error handling.
- Keep it concise: developers will read this while coding.`,
  },

  // Reviewer agent — reviews PRs and code
  reviewer: {
    model: { providerID: 'opencode', modelID: 'big-pickle' },
    system: `You are a code review agent. Your job is to review code changes and provide actionable feedback.

## Process

1. Read the PR diff or code changes.
2. Check for: bugs, security issues, performance problems, missing error handling, style inconsistencies.
3. Verify the implementation matches the issue requirements.
4. Check that tests cover the changes.

## Output

Provide feedback as:
- **Critical**: Must fix before merge (bugs, security, data loss)
- **Important**: Should fix (error handling, performance, maintainability)
- **Suggestion**: Nice to have (style, naming, documentation)

Be specific: reference file paths and line numbers. Suggest fixes, don't just point out problems.`,
  },
};

// MCP servers available to all remote agents by default.
// Additional servers can be added per-request via the `mcp` body param.
//
// Format reference (from opencode docs):
//   Local:  { type: "local", command: ["npx", "-y", "package"], environment: {} }
//   Remote: { type: "remote", url: "https://...", headers: {} }
const getDefaultMcp = (_env: Env): Config['mcp'] => ({
  // Fetch: HTTP requests, web scraping — pre-installed in container, no API key
  fetch: {
    type: 'local',
    command: ['npx', '-y', '@modelcontextprotocol/server-fetch'],
    enabled: true,
  },
  // Context7: AI-powered documentation search — remote MCP, no API key
  context7: {
    type: 'remote',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
  },
  // ref-tools-docs: Documentation search with ref.tools
  'ref-tools-docs': {
    type: 'remote',
    url: 'https://api.ref.tools/mcp',
    enabled: true,
  },
});

const getConfig = (env: Env, extraMcp?: Config['mcp']): Config => ({
  // We use free models (opencode/big-pickle etc.) which route through
  // opencode's built-in proxy — no API key needed. Don't configure
  // the Anthropic provider since the key is out of credits (AGE-246)
  // and it causes confusion when opencode tries to use it.
  mcp: {
    ...getDefaultMcp(env),
    ...extraMcp,
  },
});

/**
 * Get an opencode SDK client for the sandbox.
 * createOpencode starts `opencode serve` if not already running.
 */
async function getClient(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  extraMcp?: Config['mcp'],
) {
  return createOpencode<SdkClient>(sandbox, {
    directory: WORK_DIR,
    config: getConfig(env, extraMcp),
  });
}

// ---------------------------------------------------------------------------
// Shared: set up the container workspace (clone, git, gh, secrets, lb)
// ---------------------------------------------------------------------------
/**
 * Returns the repo URL that was set up (existing or newly created).
 */
async function setupWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  opts: {
    repo?: string;
    project?: string;
    branch?: string;
    setupLb?: boolean;
    workspace?: string; // named workspace to restore from R2
  },
): Promise<string | null> {
  // Clean workspace
  await sandbox.exec(`cd /tmp && rm -rf ${WORK_DIR}`);

  let repoUrl: string | null = null;

  if (opts.repo) {
    // Clone existing repo
    await sandbox.gitCheckout(opts.repo, { targetDir: WORK_DIR });
    repoUrl = opts.repo;
  } else if (opts.project && env.GH_TOKEN) {
    // Check if repo already exists, if so clone it; otherwise create it
    const check = await sandbox.exec(
      `gh repo view agentic-flows/${opts.project} --json url 2>&1`,
    );
    if (check.stdout?.includes('url')) {
      // Repo exists — clone it
      const parsed = JSON.parse(check.stdout);
      repoUrl = parsed.url + '.git';
      await sandbox.gitCheckout(repoUrl, { targetDir: WORK_DIR });
    } else {
      // Create new repo with an initial commit so --push works
      await sandbox.exec(`mkdir -p ${WORK_DIR}`);
      await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
      await sandbox.exec(
        `cd ${WORK_DIR} && echo "# ${opts.project}" > README.md && git add README.md && git commit -m "init"`,
      );
      await sandbox.exec(
        `cd ${WORK_DIR} && gh repo create agentic-flows/${opts.project} --private --source=. --push 2>&1`,
      );
      repoUrl = `https://github.com/agentic-flows/${opts.project}.git`;
    }
  } else if (opts.workspace) {
    // Named workspace — try to restore from R2 first
    let restored = false;
    try {
      restored = await restoreWorkspace(sandbox, env, `named/${opts.workspace}`);
    } catch (e) {
      // Log but don't fail — fall through to fresh workspace
      console.error('Workspace restore failed:', e);
    }
    if (!restored) {
      // No existing snapshot or restore failed — create fresh workspace
      await sandbox.exec(`mkdir -p ${WORK_DIR}`);
      await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
    }
  } else {
    // Bare workspace — no git remote
    await sandbox.exec(`mkdir -p ${WORK_DIR}`);
    await sandbox.exec(`cd ${WORK_DIR} && git init -b main`);
  }

  // Git identity
  if (env.GIT_AUTHOR_NAME) {
    await sandbox.exec(`git config --global user.name "${env.GIT_AUTHOR_NAME}"`);
  }
  if (env.GIT_AUTHOR_EMAIL) {
    await sandbox.exec(`git config --global user.email "${env.GIT_AUTHOR_EMAIL}"`);
  }
  await sandbox.exec(`git config --global --add safe.directory ${WORK_DIR}`);

  // GitHub CLI auth + git credential helper (so git push works via gh)
  if (env.GH_TOKEN) {
    await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token`);
    await sandbox.exec(`git config --global credential.helper "!gh auth git-credential"`);
  }

  // Inject secrets into container environment (persists for all subsequent exec calls)
  // Write them to /etc/environment so all processes (including opencode's bash tool) see them
  const envLines: string[] = [];
  if (env.LINEAR_API_KEY) envLines.push(`LINEAR_API_KEY=${env.LINEAR_API_KEY}`);
  if (env.GH_TOKEN) envLines.push(`GH_TOKEN=${env.GH_TOKEN}`);
  if (env.ANTHROPIC_API_KEY) envLines.push(`ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`);
  if (env.GIT_AUTHOR_NAME) envLines.push(`GIT_AUTHOR_NAME=${env.GIT_AUTHOR_NAME}`);
  if (env.GIT_AUTHOR_EMAIL) envLines.push(`GIT_AUTHOR_EMAIL=${env.GIT_AUTHOR_EMAIL}`);
  if (envLines.length > 0) {
    // Write to profile so interactive and non-interactive shells pick them up
    const exports = envLines.map((l) => `export ${l}`).join('\n');
    await sandbox.exec(`echo '${exports}' >> /root/.bashrc`);
    // Also set them in the current shell context for immediate use
    await sandbox.exec(exports);
  }

  // Checkout branch if specified
  if (opts.branch) {
    const check = await sandbox.exec(
      `cd ${WORK_DIR} && git ls-remote --exit-code --heads origin "${opts.branch}" 2>/dev/null && echo EXISTS || echo NEW`,
    );
    if (check.stdout?.includes('EXISTS')) {
      await sandbox.exec(
        `cd ${WORK_DIR} && git checkout -b "${opts.branch}" "origin/${opts.branch}"`,
      );
    } else {
      await sandbox.exec(`cd ${WORK_DIR} && git checkout -b "${opts.branch}"`);
    }
  }

  // Set up lb if requested
  if (opts.setupLb && env.LINEAR_API_KEY) {
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb onboard 2>&1 || true`,
    );
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb sync 2>&1 || true`,
    );
  }

  return repoUrl;
}

// ---------------------------------------------------------------------------
// R2 Workspace Persistence
// ---------------------------------------------------------------------------
// Workspace snapshots are stored in R2 as tar.gz archives.
// Keys: workspaces/<name>.tar.gz (named) or workspaces/session-<id>.tar.gz
//
// Excludes: node_modules, .git, __pycache__, .next, dist (to keep archives small)
const WORKSPACE_EXCLUDES = [
  '--exclude=node_modules',
  '--exclude=.git',
  '--exclude=__pycache__',
  '--exclude=.next',
  '--exclude=dist',
  '--exclude=.opencode',
].join(' ');

/**
 * Save the current workspace to R2 as a compressed tar archive.
 *
 * Strategy: tar + gzip + base64-encode inside the container, then read the
 * base64 text via exec (ASCII-safe, avoids readFileStream's structured
 * envelope format). Decode from base64 in the Worker before uploading to R2.
 */
async function saveWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  key: string,
): Promise<{ key: string; size: number }> {
  const r2Key = `workspaces/${key}.tar.gz`;
  const archivePath = '/tmp/workspace-snapshot.tar.gz';
  const b64Path = '/tmp/workspace-snapshot.b64';

  // Create compressed archive (excluding heavy dirs)
  await sandbox.exec(
    `cd /home/user && tar czf ${archivePath} ${WORKSPACE_EXCLUDES} workspace/ 2>&1`,
  );

  // Base64-encode inside the container so we can read it as ASCII text
  await sandbox.exec(`base64 ${archivePath} > ${b64Path}`);

  // Read the base64 text (ASCII-safe) via exec in chunks
  // First get the size to know how many chunks we need
  const sizeResult = await sandbox.exec(`wc -c < ${b64Path}`);
  const b64Size = parseInt(sizeResult.stdout?.trim() || '0', 10);

  if (b64Size === 0) {
    throw new Error('Failed to create workspace archive');
  }

  // Read base64 in chunks via exec (each exec has output limits)
  // Use dd for precise byte-range reads
  const CHUNK_SIZE = 200000; // ~200KB per read, well within exec limits
  let b64String = '';
  for (let offset = 0; offset < b64Size; offset += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, b64Size - offset);
    const result = await sandbox.exec(
      `dd if=${b64Path} bs=1 skip=${offset} count=${count} 2>/dev/null`,
    );
    b64String += result.stdout || '';
  }

  // Strip whitespace (base64 command adds line breaks)
  b64String = b64String.replace(/\s/g, '');

  // Decode from base64 to binary
  const binaryString = atob(b64String);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  await env.R2_BUCKET.put(r2Key, bytes.buffer);

  // Clean up temp files
  await sandbox.exec(`rm -f ${archivePath} ${b64Path}`);

  return { key: r2Key, size: bytes.length };
}

/**
 * Restore a workspace from R2 into the container.
 *
 * The sandbox writeFile API uses UTF-8 encoding which corrupts binary data.
 * Instead, we convert to base64 (ASCII-safe) and write it via shell commands,
 * then decode inside the container.
 *
 * Returns true if a snapshot was found and restored.
 */
async function restoreWorkspace(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  key: string,
): Promise<boolean> {
  const r2Key = `workspaces/${key}.tar.gz`;

  // Check if snapshot exists in R2
  const obj = await env.R2_BUCKET.get(r2Key);
  if (!obj) return false;

  // Convert binary → base64 (ASCII-safe for shell transport)
  const data = await obj.arrayBuffer();
  const bytes = new Uint8Array(data);

  // Encode to base64 manually using Buffer-style approach
  // We can't use btoa with fromCharCode on binary data that goes through
  // writeFile (UTF-8 encoding corrupts bytes > 127).
  // Instead, use the container's own base64 command to verify.
  //
  // Strategy: write raw base64 via small exec calls using heredoc,
  // which avoids writeFile's UTF-8 mangling entirely.
  const b64File = '/tmp/_ws_restore.b64';
  const tarFile = '/tmp/_ws_restore.tar.gz';
  await sandbox.exec(`rm -f ${b64File} ${tarFile}`);

  // Use standard base64 encoding via a lookup table (avoids btoa/fromCharCode issues)
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let base64 = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    base64 += base64Chars[a >> 2];
    base64 += base64Chars[((a & 3) << 4) | (b >> 4)];
    base64 += i + 1 < bytes.length ? base64Chars[((b & 15) << 2) | (c >> 6)] : '=';
    base64 += i + 2 < bytes.length ? base64Chars[c & 63] : '=';
  }

  // Write base64 string to container in chunks via shell
  // Base64 is pure ASCII (A-Za-z0-9+/=) so shell-safe in single quotes
  const CHUNK_SIZE = 50000; // well under ARG_MAX
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    const chunk = base64.slice(i, i + CHUNK_SIZE);
    await sandbox.exec(`printf '%s' '${chunk}' >> ${b64File}`);
  }

  // Decode and extract
  const decodeResult = await sandbox.exec(
    `base64 -d ${b64File} > ${tarFile} 2>&1 && echo DECODE_OK || echo DECODE_FAIL`,
  );
  if (!decodeResult.stdout?.includes('DECODE_OK')) {
    console.error('restoreWorkspace: base64 decode failed:', decodeResult.stdout, decodeResult.stderr);
    await sandbox.exec(`rm -f ${b64File} ${tarFile}`);
    return false;
  }

  const extractResult = await sandbox.exec(
    `cd /home/user && tar xzf ${tarFile} 2>&1 && echo EXTRACT_OK || echo EXTRACT_FAIL`,
  );
  if (!extractResult.stdout?.includes('EXTRACT_OK')) {
    console.error('restoreWorkspace: tar extract failed:', extractResult.stdout, extractResult.stderr);
    await sandbox.exec(`rm -f ${b64File} ${tarFile}`);
    return false;
  }

  // Clean up
  await sandbox.exec(`rm -f ${b64File} ${tarFile}`);

  return true;
}

/**
 * Resolve the R2 workspace key from request params.
 * Priority: explicit workspace name > issueId > sessionId
 */
function resolveWorkspaceKey(opts: {
  workspace?: string;
  issueId?: string;
  sessionId?: string;
}): string {
  if (opts.workspace) return `named/${opts.workspace}`;
  if (opts.issueId) return `issue/${opts.issueId}`;
  if (opts.sessionId) return `session/${opts.sessionId}`;
  return `session/${crypto.randomUUID()}`;
}

// ===========================================================================
// Router
// ===========================================================================
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- API routes ---

    // POST /api/dispatch — dispatch an lb issue to a remote agent
    if (request.method === 'POST' && url.pathname === '/api/dispatch') {
      return handleDispatch(sandbox, env, request);
    }

    // POST /api/kickoff — raw prompt (no lb integration)
    if (request.method === 'POST' && url.pathname === '/api/kickoff') {
      return handleKickoff(sandbox, env, request);
    }

    // GET /api/session/:id/messages — conversation messages
    const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (request.method === 'GET' && messagesMatch) {
      return handleMessages(sandbox, env, messagesMatch[1]);
    }

    // GET /api/session/:id — session status
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (request.method === 'GET' && sessionMatch) {
      return handleSessionStatus(sandbox, env, sessionMatch[1]);
    }

    // POST /api/session/:id/prompt — follow-up prompt
    const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (request.method === 'POST' && promptMatch) {
      return handleFollowUp(sandbox, env, promptMatch[1], request);
    }

    // POST /api/exec — run command in container
    if (request.method === 'POST' && url.pathname === '/api/exec') {
      return handleExec(sandbox, request);
    }

    // GET /api/sessions — list all sessions (persisted + live)
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return handleListSessions(sandbox, env);
    }

    // POST /api/session/:id/snapshot — capture current messages to persistent storage
    const snapshotMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/snapshot$/);
    if (request.method === 'POST' && snapshotMatch) {
      return handleSnapshot(sandbox, env, snapshotMatch[1]);
    }

    // POST /api/workspace/save — save workspace to R2
    // Body: { "workspace": "name" } or { "sessionId": "..." } or { "issueId": "..." }
    if (request.method === 'POST' && url.pathname === '/api/workspace/save') {
      return handleWorkspaceSave(sandbox, env, request);
    }

    // GET /api/workspace/list — list saved workspaces in R2
    if (request.method === 'GET' && url.pathname === '/api/workspace/list') {
      return handleWorkspaceList(env);
    }

    // DELETE /api/workspace/:name — delete a named workspace from R2
    const deleteWorkspaceMatch = url.pathname.match(/^\/api\/workspace\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteWorkspaceMatch) {
      return handleWorkspaceDelete(env, deleteWorkspaceMatch[1]);
    }

    // GET /api/workspace/file/* — read a file from the live container workspace
    if (request.method === 'GET' && url.pathname.startsWith('/api/workspace/file/')) {
      const filePath = url.pathname.slice('/api/workspace/file/'.length);
      return handleWorkspaceFile(sandbox, filePath);
    }

    // GET /api/profiles — list available agent profiles
    if (request.method === 'GET' && url.pathname === '/api/profiles') {
      const profiles = Object.fromEntries(
        Object.entries(AGENT_PROFILES).map(([name, p]) => [
          name,
          {
            model: p.model,
            hasSystemPrompt: !!p.system,
            systemPromptPreview: p.system?.slice(0, 200) ?? null,
            hasMcp: !!p.mcp && Object.keys(p.mcp).length > 0,
          },
        ]),
      );
      return Response.json({ profiles });
    }

    // Everything else: proxy to the opencode web UI
    const server = await createOpencodeServer(sandbox, {
      directory: WORK_DIR,
      config: getConfig(env),
    });
    return proxyToOpencode(request, sandbox, server);
  },
};

// ===========================================================================
// POST /api/dispatch
// Dispatch an lb issue to a remote agent.
//
// Body: { "issueId": "AGE-42", "repo"?: "...",
//         "model"?: { "providerID": "...", "modelID": "..." },
//         "mcp"?: { "name": { type: "local", command: [...] } },
//         "system"?: "custom system prompt",
//         "profile"?: "researcher" | "coder" | "refiner" | "reviewer" }
//
// This is the main integration point with lb/Linear:
// 1. Clones the repo
// 2. Sets up lb (onboard + sync) with LINEAR_API_KEY
// 3. Reads the issue via `lb show`
// 4. Creates a branch named <issueId>-remote
// 5. Claims the issue (lb update --status in_progress)
// 6. Sends the agent a prompt with the full issue description
// 7. The agent works autonomously: code, commit, push, PR, lb update
// ===========================================================================
async function handleDispatch(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      issueId?: string;
      repo?: string;
      model?: { providerID: string; modelID: string };
      mcp?: Config['mcp'];
      system?: string;
      profile?: string;
    };
    if (!body.issueId) {
      return Response.json({ error: 'Missing "issueId" in request body' }, { status: 400 });
    }
    if (!body.repo) {
      return Response.json({ error: 'Missing "repo" in request body (e.g. "https://github.com/org/repo.git")' }, { status: 400 });
    }
    if (!env.LINEAR_API_KEY) {
      return Response.json(
        { error: 'LINEAR_API_KEY not configured — lb cannot sync with Linear' },
        { status: 500 },
      );
    }

    // Resolve profile (if specified) — profile provides defaults for model, system, mcp
    const profile = body.profile ? AGENT_PROFILES[body.profile] : undefined;
    if (body.profile && !profile) {
      return Response.json(
        { error: `Unknown profile "${body.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` },
        { status: 400 },
      );
    }

    const issueId = body.issueId.toUpperCase();
    const branch = `${issueId}-remote`;

    // Set up workspace with lb
    await setupWorkspace(sandbox, env, {
      repo: body.repo,
      branch,
      setupLb: true,
    });

    // Read the issue description via lb
    const issueResult = await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb show ${issueId} 2>&1`,
    );
    const issueDescription = issueResult.stdout || '';
    if (!issueDescription || issueDescription.includes('not found')) {
      return Response.json(
        { error: `Issue ${issueId} not found. Run lb sync first?`, raw: issueDescription },
        { status: 404 },
      );
    }

    // Claim the issue
    await sandbox.exec(
      `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb update ${issueId} --status in_progress 2>&1 || true`,
    );

    // Merge MCP: profile MCP (defaults) + body MCP (overrides)
    const mergedMcp = { ...profile?.mcp, ...body.mcp };

    // Start opencode serve + get SDK client (with MCP servers)
    const { client } = await getClient(sandbox, env, mergedMcp);

    // Create session
    const session = await client.session.create({
      title: `${issueId} — Remote Agent`,
      directory: WORK_DIR,
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Build the agent prompt
    const prompt = buildDispatchPrompt(issueId, branch, issueDescription, env);

    // Resolve model: explicit > profile > default
    const model = body.model || profile?.model || DEFAULT_MODEL;

    // Resolve system prompt: explicit > profile > none
    // System prompt is prepended to the dispatch prompt so the agent
    // gets both its role context and the issue-specific instructions.
    const systemPrompt = body.system || profile?.system;
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${prompt}`
      : prompt;

    // Fire prompt async
    await client.session.promptAsync({
      sessionID: session.data.id,
      directory: WORK_DIR,
      model,
      parts: [{ type: 'text', text: fullPrompt }],
    });

    // Persist session log to DO SQLite (survives container hibernation)
    await (sandbox as Sandbox).logSession({
      sessionId: session.data.id,
      issueId,
      prompt: fullPrompt,
      model,
      repo: body.repo,
      branch,
      workspaceKey: `issue/${issueId}`,
    });

    return Response.json({
      sessionId: session.data.id,
      issueId,
      branch,
      status: 'dispatched',
      model,
      profile: body.profile ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Build the prompt sent to the remote agent for an lb issue.
 * This is self-contained — the agent has no prior context.
 */
function buildDispatchPrompt(
  issueId: string,
  branch: string,
  issueDescription: string,
  env: Env,
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

// ===========================================================================
// POST /api/kickoff — raw prompt
// Body: { "text": "...", "repo"?: "...", "project"?: "...", "branch"?: "...",
//         "model"?: { "providerID": "...", "modelID": "..." },
//         "mcp"?: { ... }, "system"?: "...", "profile"?: "researcher",
//         "workspace"?: "my-scraper" }
//
// Four workspace modes:
//   1. "repo": "https://..." — clone existing repo
//   2. "project": "my-research" — create/clone github.com/agentic-flows/my-research
//   3. "workspace": "name" — named R2 workspace (persists across sessions)
//   4. Neither — ephemeral workspace (no persistence)
// ===========================================================================
async function handleKickoff(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      text?: string;
      repo?: string;
      project?: string;
      branch?: string;
      model?: { providerID: string; modelID: string };
      mcp?: Config['mcp'];
      system?: string;
      profile?: string;
      workspace?: string; // named workspace — persists across sessions via R2
    };
    if (!body.text) {
      return Response.json({ error: 'Missing "text" in request body' }, { status: 400 });
    }

    // Resolve profile
    const profile = body.profile ? AGENT_PROFILES[body.profile] : undefined;
    if (body.profile && !profile) {
      return Response.json(
        { error: `Unknown profile "${body.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` },
        { status: 400 },
      );
    }

    const repoUrl = await setupWorkspace(sandbox, env, {
      repo: body.repo,
      project: body.project,
      branch: body.branch,
      workspace: body.workspace,
      setupLb: false,
    });

    // Merge MCP: profile MCP (defaults) + body MCP (overrides)
    const mergedMcp = { ...profile?.mcp, ...body.mcp };

    const { client } = await getClient(sandbox, env, mergedMcp);

    const session = await client.session.create({
      title: body.workspace
        ? `Workspace: ${body.workspace}`
        : body.project
          ? `Project: ${body.project}`
          : 'Remote Agent',
      directory: WORK_DIR,
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Build the prompt with persistence instructions and system prompt
    let promptText = body.text;
    if (repoUrl) {
      promptText += `\n\n## Persistence\n\nYour workspace is backed by a GitHub repo: ${repoUrl}\nWhen you are done, commit all your work and push it so nothing is lost.\nUse: \`git add -A && git commit -m "description" && git push\`\nIf pushing fails with auth errors, use: \`git push https://\${GH_TOKEN}@github.com/... HEAD:refs/heads/main\``;
    } else if (body.workspace) {
      promptText += `\n\n## Persistence\n\nYour workspace is a named R2 workspace: "${body.workspace}"\nYour work will be automatically saved when the session completes.\nYou do not need to push to git unless you want to — files persist in R2.`;
    }

    // Resolve system prompt: explicit > profile > none
    const systemPrompt = body.system || profile?.system;
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${promptText}`
      : promptText;

    // Resolve model: explicit > profile > default
    const model = body.model || profile?.model || DEFAULT_MODEL;

    await client.session.promptAsync({
      sessionID: session.data.id,
      directory: WORK_DIR,
      model,
      parts: [{ type: 'text', text: fullPrompt }],
    });

    // Resolve the workspace key for later save operations
    const workspaceKey = body.workspace
      ? `named/${body.workspace}`
      : undefined;

    // Persist session log to DO SQLite (survives container hibernation)
    await (sandbox as Sandbox).logSession({
      sessionId: session.data.id,
      prompt: fullPrompt,
      model,
      repo: repoUrl ?? undefined,
      workspaceKey,
    });

    return Response.json({
      sessionId: session.data.id,
      status: 'kicked off',
      model,
      repo: repoUrl,
      profile: body.profile ?? null,
      workspace: body.workspace ?? null,
      workspaceKey: workspaceKey ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ===========================================================================
// GET /api/session/:id/messages
// Try live container first; fall back to persisted messages in DO SQLite.
// When live messages are available, also snapshot them to SQLite.
// ===========================================================================
async function handleMessages(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
): Promise<Response> {
  try {
    const { client } = await getClient(sandbox, env);
    const messages = await client.session.messages({
      sessionID: sessionId,
      directory: WORK_DIR,
    });
    const liveMessages = messages.data ?? [];

    // Snapshot live messages to DO SQLite for persistence
    if (liveMessages.length > 0) {
      try {
        await (sandbox as Sandbox).saveMessages(sessionId, liveMessages);
      } catch {
        // Non-fatal — don't fail the request if snapshotting fails
      }
    }

    return Response.json({ source: 'live', messages: liveMessages });
  } catch {
    // Container is likely dead — fall back to persisted messages
    try {
      const saved = await (sandbox as Sandbox).getSessionMessages(sessionId);
      const log = await (sandbox as Sandbox).getSessionLog(sessionId);
      return Response.json({
        source: 'persisted',
        session: log,
        messages: saved,
      });
    } catch (fallbackError) {
      const msg = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
      return Response.json({ error: `Container unavailable and no persisted messages found: ${msg}` }, { status: 404 });
    }
  }
}

// ===========================================================================
// POST /api/exec — run command in container (debug)
// Body: { "command": "..." }
// ===========================================================================
async function handleExec(
  sandbox: ReturnType<typeof getSandbox>,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as { command?: string };
    if (!body.command) {
      return Response.json({ error: 'Missing "command"' }, { status: 400 });
    }

    const result = await sandbox.exec(body.command);
    return Response.json({
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ===========================================================================
// GET /api/session/:id — session info + status
// Try live container first; fall back to persisted session log.
// ===========================================================================
async function handleSessionStatus(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
): Promise<Response> {
  try {
    const { client } = await getClient(sandbox, env);
    const [session, status] = await Promise.all([
      client.session.get({ sessionID: sessionId, directory: WORK_DIR }),
      client.session.status({ directory: WORK_DIR }),
    ]);

    // If session is idle, snapshot messages and update status
    const statusData = status.data ?? {};
    const sessionBusy = statusData[sessionId]?.type === 'busy';
    if (!sessionBusy) {
      try {
        const msgs = await client.session.messages({ sessionID: sessionId, directory: WORK_DIR });
        if (msgs.data?.length) {
          await (sandbox as Sandbox).saveMessages(sessionId, msgs.data);
          await (sandbox as Sandbox).updateSessionStatus(sessionId, 'completed');
        }
      } catch {
        // Non-fatal
      }
    }

    return Response.json({
      source: 'live',
      session: session.data ?? null,
      status: statusData,
    });
  } catch {
    // Container dead — return persisted log
    try {
      const log = await (sandbox as Sandbox).getSessionLog(sessionId);
      if (log) {
        return Response.json({
          source: 'persisted',
          session: log,
          status: { containerDead: true },
        });
      }
    } catch {
      // fall through
    }
    return Response.json({ error: `Session ${sessionId} not found (container unavailable)` }, { status: 404 });
  }
}

// ===========================================================================
// POST /api/session/:id/prompt — send follow-up (async)
// Body: { "text": "...", "model"?: { ... } }
// ===========================================================================
async function handleFollowUp(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      text?: string;
      model?: { providerID: string; modelID: string };
    };
    if (!body.text) {
      return Response.json({ error: 'Missing "text"' }, { status: 400 });
    }

    const { client } = await getClient(sandbox, env);
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: WORK_DIR,
      model: body.model || DEFAULT_MODEL,
      parts: [{ type: 'text', text: body.text }],
    });

    return Response.json({ status: 'sent' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ===========================================================================
// GET /api/sessions — list all sessions
// Returns persisted session logs from DO SQLite (always available).
// Also includes live sessions from the container when it's running.
// ===========================================================================
async function handleListSessions(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
): Promise<Response> {
  // Always return persisted logs — they survive container death
  const persisted = await (sandbox as Sandbox).getSessions();

  // Try to also get live sessions from the container
  let live: any[] = [];
  try {
    const { client } = await getClient(sandbox, env);
    const sessions = await client.session.list({ directory: WORK_DIR });
    live = sessions.data ?? [];
  } catch {
    // Container dead — that's fine, persisted data is the primary source
  }

  return Response.json({
    sessions: persisted,
    live,
  });
}

// ===========================================================================
// POST /api/session/:id/snapshot — capture messages to persistent storage
// Call this while the container is alive to save messages before it dies.
// ===========================================================================
async function handleSnapshot(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
): Promise<Response> {
  try {
    const { client } = await getClient(sandbox, env);
    const [messages, status] = await Promise.all([
      client.session.messages({ sessionID: sessionId, directory: WORK_DIR }),
      client.session.status({ directory: WORK_DIR }),
    ]);

    const liveMessages = messages.data ?? [];
    if (liveMessages.length > 0) {
      await (sandbox as Sandbox).saveMessages(sessionId, liveMessages);
    }

    // Update status based on whether session is still busy
    const statusData = status.data ?? {};
    const sessionBusy = statusData[sessionId]?.type === 'busy';
    await (sandbox as Sandbox).updateSessionStatus(
      sessionId,
      sessionBusy ? 'running' : 'completed',
    );

    return Response.json({
      snapshotted: liveMessages.length,
      status: sessionBusy ? 'running' : 'completed',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: `Failed to snapshot (container may be dead): ${message}` }, { status: 500 });
  }
}

// ===========================================================================
// POST /api/workspace/save — save workspace to R2
// Body: { "workspace"?: "name", "sessionId"?: "...", "issueId"?: "..." }
// At least one identifier required to determine the R2 key.
// ===========================================================================
async function handleWorkspaceSave(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      workspace?: string;
      sessionId?: string;
      issueId?: string;
    };

    const key = resolveWorkspaceKey(body);
    const result = await saveWorkspace(sandbox, env, key);

    return Response.json({
      saved: true,
      key: result.key,
      size: result.size,
      sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: `Failed to save workspace: ${message}` }, { status: 500 });
  }
}

// ===========================================================================
// GET /api/workspace/list — list saved workspaces in R2
// ===========================================================================
async function handleWorkspaceList(env: Env): Promise<Response> {
  try {
    const list = await env.R2_BUCKET.list({ prefix: 'workspaces/' });
    const workspaces = list.objects.map((obj) => ({
      key: obj.key,
      name: obj.key.replace('workspaces/', '').replace('.tar.gz', ''),
      size: obj.size,
      sizeHuman: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
      uploaded: obj.uploaded.toISOString(),
    }));

    return Response.json({ workspaces });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ===========================================================================
// DELETE /api/workspace/:name — delete a named workspace from R2
// ===========================================================================
async function handleWorkspaceDelete(env: Env, name: string): Promise<Response> {
  try {
    const key = `workspaces/named/${name}.tar.gz`;
    await env.R2_BUCKET.delete(key);
    return Response.json({ deleted: true, key });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ===========================================================================
// GET /api/workspace/file/* — read a file from the live container workspace
// Returns the file content as text. For binary files, use /api/exec.
// ===========================================================================
async function handleWorkspaceFile(
  sandbox: ReturnType<typeof getSandbox>,
  filePath: string,
): Promise<Response> {
  try {
    if (!filePath || filePath.includes('..')) {
      return Response.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const fullPath = `${WORK_DIR}/${filePath}`;

    // Check if path is a directory
    const checkResult = await sandbox.exec(`test -d "${fullPath}" && echo DIR || test -f "${fullPath}" && echo FILE || echo NOTFOUND`);
    const type = checkResult.stdout?.trim();

    if (type === 'NOTFOUND') {
      return Response.json({ error: `File not found: ${filePath}` }, { status: 404 });
    }

    if (type === 'DIR') {
      // List directory contents
      const lsResult = await sandbox.exec(`ls -la "${fullPath}"`);
      return Response.json({
        type: 'directory',
        path: filePath,
        listing: lsResult.stdout,
      });
    }

    // Read file content
    const result = await sandbox.readFile(fullPath);
    return new Response(result.content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-File-Path': filePath,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
