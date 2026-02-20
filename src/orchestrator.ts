/**
 * Orchestrator — AIChatAgent Durable Object
 *
 * The brain of the remote-agents system. You chat with it to manage
 * remote coding agents running in Cloudflare Containers.
 *
 * Features:
 * - Persistent conversation history (survives page reloads, DO hibernation)
 * - Persistent agent state (which containers are running)
 * - Tools for Linear issue management (lb_ready, lb_show, etc.)
 * - Tools for container lifecycle (launch, check, message, abort)
 * - Streaming responses via AI SDK
 * - @callable RPC methods for the dashboard
 */
import { AIChatAgent } from '@cloudflare/ai-chat';
import { routeAgentRequest, callable } from 'agents';
import { streamText, convertToModelMessages, stepCountIs } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createLbTools } from './tools/lb.js';
import { createContainerTools } from './tools/container.js';

// Import env types
import './env.js';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  sandboxId: string;
  sessionId: string;
  branch: string;
  status: 'launching' | 'running' | 'done' | 'failed' | 'aborted';
  launchedAt: string;
}

export interface OrchestratorState {
  agents: Record<string, AgentEntry>; // keyed by issue identifier (e.g. "AGE-172")
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(state: OrchestratorState): string {
  const agentEntries = Object.entries(state.agents);
  const agentSummary =
    agentEntries.length > 0
      ? agentEntries
          .map(
            ([id, a]) =>
              `- ${id}: ${a.status} (branch: ${a.branch}, sandbox: ${a.sandboxId})`,
          )
          .join('\n')
      : '(none)';

  return `You are the Orchestrator, an AI agent that manages remote coding agents on Cloudflare infrastructure.

## Your Role
You help the user manage a team of AI coding agents. Each agent runs in an isolated Cloudflare Container with opencode, git, gh, and lb (linear-beads). Agents work on Linear issues autonomously.

## Current State
**Running agents:**
${agentSummary}

**Project:** remote-agents (team AGE)
**Repo:** https://github.com/agentic-flows/remote-agents

## What You Can Do

### Issue Management (via Linear API)
- **lb_ready**: Find issues ready to work on (refined + unblocked)
- **lb_show**: Read full issue details before launching an agent
- **lb_blocked**: See what's stuck and why
- **lb_list**: Browse all issues
- **lb_update**: Change issue status
- **lb_create**: Create new issues

### Agent Management (via Sandbox containers)
- **launch_agent**: Spin up a container + opencode for an issue
- **check_agent**: See what an agent is doing
- **message_agent**: Send follow-up instructions
- **abort_agent**: Stop an agent
- **destroy_agent**: Tear down a container completely
- **list_agents**: See all tracked agents

## Guidelines
1. Always run lb_show before launching an agent — understand the issue first.
2. Don't launch agents for blocked issues. Check lb_blocked if unsure.
3. When launching, include clear instructions combining the issue description with any user context.
4. Report sandbox IDs and branch names so the user can track agents.
5. Be concise but informative. Show issue identifiers (AGE-XXX) when referencing work.
6. If an issue isn't refined yet, suggest refining it before launching an agent.
7. Multiple agents can run simultaneously — that's the point of this system.`;
}

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class Orchestrator extends AIChatAgent<Env, OrchestratorState> {
  initialState: OrchestratorState = {
    agents: {},
  };

  /**
   * Handle incoming chat messages — the core of the orchestrator.
   */
  async onChatMessage(onFinish: Parameters<AIChatAgent['onChatMessage']>[0]) {
    const anthropic = createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

    // Build tools with access to env and state
    const lbTools = createLbTools(this.env);
    const containerTools = createContainerTools(
      this.env,
      () => this.state,
      (newState) => this.setState(newState),
    );

    const tools = { ...lbTools, ...containerTools };

    const result = streamText({
      model: anthropic('claude-sonnet-4-20250514'),
      system: buildSystemPrompt(this.state),
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(10), // Allow multi-step tool use
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The parent class
      // provides onFinish typed for generic ToolSet, but streamText parameterizes it
      // with our concrete tool types. The shapes are compatible at runtime; we cast to
      // bridge the contravariant generic constraint.
      onFinish: onFinish as any,
    });

    return result.toUIMessageStreamResponse();
  }

  // -----------------------------------------------------------------------
  // @callable RPC methods (for dashboard)
  // -----------------------------------------------------------------------

  /**
   * List all tracked agents.
   */
  @callable()
  listAgents(): Record<string, AgentEntry> {
    return this.state.agents;
  }

  /**
   * Get a specific agent by issue ID.
   */
  @callable()
  getAgent(issueId: string): AgentEntry | null {
    return this.state.agents[issueId] ?? null;
  }
}
