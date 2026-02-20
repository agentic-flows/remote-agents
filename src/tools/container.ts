/**
 * AI SDK tools for Sandbox container lifecycle management.
 *
 * Each tool operates on the orchestrator's `this.state.agents` registry
 * and the Sandbox DO binding to launch, check, message, and abort
 * remote coding agents running opencode inside containers.
 *
 * SDK usage follows the opencode-remote example from sandbox-sdk.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { getSandbox } from '@cloudflare/sandbox';
import { createOpencode } from '@cloudflare/sandbox/opencode';
import type { Config, OpencodeClient } from '@opencode-ai/sdk';
import { getContainerEnv } from '../secrets.js';
import { getIssue } from '../linear.js';
import type { AgentEntry, OrchestratorState } from '../orchestrator.js';

// Repo URL — the orchestrator always works with this repo
const REPO_URL = 'https://github.com/agentic-flows/remote-agents.git';
const WORK_DIR = '/home/user/workspace';

/**
 * Build opencode config from env.
 */
function getConfig(env: Env): Config {
  return {
    provider: {
      anthropic: {
        options: {
          apiKey: env.ANTHROPIC_API_KEY,
        },
      },
    },
  };
}

/**
 * Helper: get or create an opencode SDK client for a sandbox.
 */
async function getOpencodeClient(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
) {
  return createOpencode<OpencodeClient>(sandbox, {
    directory: WORK_DIR,
    config: getConfig(env),
  });
}

/**
 * Create container management tools.
 *
 * These tools need access to the orchestrator's state and env, so they
 * accept callbacks to read/write state rather than the state directly.
 */
export function createContainerTools(
  env: Env,
  getState: () => OrchestratorState,
  setState: (state: OrchestratorState) => void,
) {
  return {
    launch_agent: tool({
      description:
        'Launch a new remote coding agent for a Linear issue. Spins up a Cloudflare Container with opencode, sends the issue description as the initial task, and tracks it in state. The agent will work autonomously on the issue.',
      inputSchema: z.object({
        issueId: z.string().describe('Linear issue identifier, e.g. "AGE-172"'),
        instructions: z
          .string()
          .optional()
          .describe(
            'Additional instructions to send to the agent beyond the issue description',
          ),
      }),
      execute: async ({ issueId, instructions }): Promise<string> => {
        try {
          const state = getState();

          // Check if already running
          const existing = state.agents[issueId];
          if (existing && (existing.status === 'launching' || existing.status === 'running')) {
            return `Agent for ${issueId} is already ${existing.status} (sandbox: ${existing.sandboxId}).`;
          }

          // Get issue details
          const issue = await getIssue(env.LINEAR_API_KEY, issueId);
          if (!issue) return `Issue ${issueId} not found in Linear.`;

          const branchName = `${issueId}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
          const sandboxId = `agent-${issueId.toLowerCase()}`;

          // Update state: launching
          const newEntry: AgentEntry = {
            sandboxId,
            sessionId: '',
            branch: branchName,
            status: 'launching',
            launchedAt: new Date().toISOString(),
          };
          setState({
            ...state,
            agents: { ...state.agents, [issueId]: newEntry },
          });

          // Get sandbox
          const sandbox = getSandbox(env.Sandbox, sandboxId);

          // Set env vars on the sandbox for the entrypoint
          const containerEnv = getContainerEnv(env);
          await sandbox.setEnvVars({
            ...containerEnv,
            REPO_URL,
            BRANCH_NAME: branchName,
            ISSUE_ID: issueId,
          });

          // Clone the repo into the workspace
          await sandbox.gitCheckout(REPO_URL, {
            targetDir: WORK_DIR,
          });

          // Get typed SDK client
          const { client } = await getOpencodeClient(sandbox, env);

          // Create an opencode session
          const session = await client.session.create({
            body: { title: `${issueId}: ${issue.title}` },
            query: { directory: WORK_DIR },
          });

          if (!session.data) {
            throw new Error(`Failed to create opencode session: ${JSON.stringify(session)}`);
          }

          const sessionId = session.data.id;

          // Build the task prompt
          const taskLines = [
            `# Task: ${issueId} — ${issue.title}`,
            '',
            '## Issue Description',
            issue.description ?? '(no description)',
            '',
          ];

          if (instructions) {
            taskLines.push('## Additional Instructions', instructions, '');
          }

          taskLines.push(
            '## Workflow',
            '1. Read the issue description above carefully.',
            '2. Implement the required changes.',
            '3. Commit your work with a descriptive message.',
            '4. Push the branch and create a PR using `gh pr create`.',
            `5. Run \`lb update ${issueId} --status in_review\` when the PR is created.`,
            '',
            `You are working on branch \`${branchName}\` in ${WORK_DIR}.`,
          );

          // Send the task
          await client.session.prompt({
            path: { id: sessionId },
            query: { directory: WORK_DIR },
            body: {
              parts: [{ type: 'text', text: taskLines.join('\n') }],
            },
          });

          // Update state: running
          const updatedState = getState();
          setState({
            ...updatedState,
            agents: {
              ...updatedState.agents,
              [issueId]: {
                ...updatedState.agents[issueId],
                sessionId,
                status: 'running',
              },
            },
          });

          return `Agent launched for ${issueId} on branch \`${branchName}\`.\nSandbox: ${sandboxId}\nSession: ${sessionId}`;
        } catch (e) {
          // Mark as failed
          const failState = getState();
          if (failState.agents[issueId]) {
            setState({
              ...failState,
              agents: {
                ...failState.agents,
                [issueId]: { ...failState.agents[issueId], status: 'failed' },
              },
            });
          }
          return `Failed to launch agent for ${issueId}: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    check_agent: tool({
      description:
        'Check the status of a running agent. Returns its current state and session info from the opencode session.',
      inputSchema: z.object({
        issueId: z.string().describe('Linear issue identifier, e.g. "AGE-172"'),
      }),
      execute: async ({ issueId }): Promise<string> => {
        try {
          const state = getState();
          const entry = state.agents[issueId];
          if (!entry) return `No agent found for ${issueId}.`;

          const lines = [
            `Agent for ${issueId}:`,
            `  Status: ${entry.status}`,
            `  Branch: ${entry.branch}`,
            `  Sandbox: ${entry.sandboxId}`,
            `  Launched: ${entry.launchedAt}`,
          ];

          // If running, try to get session info
          if (entry.status === 'running' && entry.sessionId) {
            try {
              const sandbox = getSandbox(env.Sandbox, entry.sandboxId);
              const { client } = await getOpencodeClient(sandbox, env);

              const sessions = await client.session.list();
              const session = sessions.data?.find((s: { id: string }) => s.id === entry.sessionId);

              if (session) {
                lines.push(`  Session: active (ID: ${entry.sessionId})`);
              } else {
                lines.push(`  Session: not found (may have completed or been destroyed)`);
              }
            } catch (e) {
              lines.push(`  Session: unable to check (${e instanceof Error ? e.message : 'error'})`);
            }
          }

          return lines.join('\n');
        } catch (e) {
          return `Error checking agent: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    message_agent: tool({
      description:
        'Send a follow-up message to a running agent. Use this to give additional instructions, ask for changes, or redirect work.',
      inputSchema: z.object({
        issueId: z.string().describe('Linear issue identifier, e.g. "AGE-172"'),
        message: z.string().describe('Message to send to the agent'),
      }),
      execute: async ({ issueId, message }): Promise<string> => {
        try {
          const state = getState();
          const entry = state.agents[issueId];
          if (!entry) return `No agent found for ${issueId}.`;
          if (entry.status !== 'running') {
            return `Agent for ${issueId} is not running (status: ${entry.status}).`;
          }
          if (!entry.sessionId) {
            return `Agent for ${issueId} has no session ID.`;
          }

          const sandbox = getSandbox(env.Sandbox, entry.sandboxId);
          const { client } = await getOpencodeClient(sandbox, env);

          await client.session.prompt({
            path: { id: entry.sessionId },
            query: { directory: WORK_DIR },
            body: {
              parts: [{ type: 'text', text: message }],
            },
          });

          return `Message sent to agent for ${issueId}.`;
        } catch (e) {
          return `Failed to message agent: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    abort_agent: tool({
      description:
        'Stop a running agent. The container keeps running but the current operation is cancelled.',
      inputSchema: z.object({
        issueId: z.string().describe('Linear issue identifier, e.g. "AGE-172"'),
      }),
      execute: async ({ issueId }): Promise<string> => {
        try {
          const state = getState();
          const entry = state.agents[issueId];
          if (!entry) return `No agent found for ${issueId}.`;

          if (entry.status === 'running' && entry.sessionId) {
            try {
              const sandbox = getSandbox(env.Sandbox, entry.sandboxId);
              const { client } = await getOpencodeClient(sandbox, env);
              await client.session.abort({
                path: { id: entry.sessionId },
              });
            } catch {
              // Container may already be stopped
            }
          }

          const updatedState = getState();
          setState({
            ...updatedState,
            agents: {
              ...updatedState.agents,
              [issueId]: { ...updatedState.agents[issueId], status: 'aborted' },
            },
          });

          return `Agent for ${issueId} has been aborted.`;
        } catch (e) {
          return `Error aborting agent: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    destroy_agent: tool({
      description:
        'Completely tear down an agent container. Destroys the sandbox and removes it from state.',
      inputSchema: z.object({
        issueId: z.string().describe('Linear issue identifier, e.g. "AGE-172"'),
      }),
      execute: async ({ issueId }): Promise<string> => {
        try {
          const state = getState();
          const entry = state.agents[issueId];
          if (!entry) return `No agent found for ${issueId}.`;

          // Try to destroy the sandbox
          try {
            const sandbox = getSandbox(env.Sandbox, entry.sandboxId);
            await sandbox.destroy();
          } catch {
            // Container may already be destroyed
          }

          // Remove from state
          const updatedState = getState();
          const { [issueId]: _, ...remaining } = updatedState.agents;
          setState({ ...updatedState, agents: remaining });

          return `Agent for ${issueId} destroyed and removed from state.`;
        } catch (e) {
          return `Error destroying agent: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    list_agents: tool({
      description:
        'List all tracked agents with their status, branch, and sandbox info.',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        const state = getState();
        const entries = Object.entries(state.agents);
        if (entries.length === 0) return 'No agents tracked.';

        return entries
          .map(
            ([id, a]) =>
              `${id}: ${a.status} | branch: ${a.branch} | sandbox: ${a.sandboxId} | launched: ${a.launchedAt}`,
          )
          .join('\n');
      },
    }),
  };
}
