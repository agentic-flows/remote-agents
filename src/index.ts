/**
 * Remote Agents Worker
 *
 * Simple Worker that spins up a Sandbox container running opencode serve,
 * then proxies requests to it. Two modes:
 *
 * 1. Web UI — browse to / for the opencode web experience
 * 2. Programmatic — POST /api/prompt to send tasks to the agent
 *
 * Based on the sandbox-sdk opencode-remote reference example.
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode,
} from '@cloudflare/sandbox/opencode';
import type { Config, OpencodeClient } from '@opencode-ai/sdk';

export { Sandbox } from '@cloudflare/sandbox';

const WORK_DIR = '/home/user/workspace';
const REPO_URL = 'https://github.com/agentic-flows/remote-agents.git';

const getConfig = (env: Env): Config => ({
  provider: {
    anthropic: {
      options: {
        apiKey: env.ANTHROPIC_API_KEY,
      },
    },
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Programmatic: send a prompt to the agent
    if (request.method === 'POST' && url.pathname === '/api/prompt') {
      return handlePrompt(sandbox, env, request);
    }

    // Everything else: proxy to the opencode web UI
    const server = await createOpencodeServer(sandbox, {
      directory: WORK_DIR,
      config: getConfig(env),
    });
    return proxyToOpencode(request, sandbox, server);
  },
};

/**
 * Handle a programmatic prompt request.
 *
 * POST /api/prompt
 * Body: { "text": "your prompt here", "repo"?: "https://github.com/..." }
 */
async function handlePrompt(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as { text?: string; repo?: string };
    const text = body.text;
    if (!text) {
      return Response.json({ error: 'Missing "text" in request body' }, { status: 400 });
    }

    const repo = body.repo || REPO_URL;

    // Clone the repo
    await sandbox.gitCheckout(repo, { targetDir: WORK_DIR });

    // Set up git + gh auth
    if (env.GIT_AUTHOR_NAME) {
      await sandbox.exec(`git config --global user.name "${env.GIT_AUTHOR_NAME}"`);
    }
    if (env.GIT_AUTHOR_EMAIL) {
      await sandbox.exec(`git config --global user.email "${env.GIT_AUTHOR_EMAIL}"`);
    }
    if (env.GH_TOKEN) {
      await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token`);
    }

    // Get typed SDK client (starts opencode serve inside the container)
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: WORK_DIR,
      config: getConfig(env),
    });

    // Create a session
    const session = await client.session.create({
      body: { title: 'Remote Agent Session' },
      query: { directory: WORK_DIR },
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Send the prompt
    const result = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory: WORK_DIR },
      body: {
        parts: [{ type: 'text', text }],
      },
    });

    // Extract text response
    const parts = result.data?.parts ?? [];
    const textPart = parts.find((p: { type: string }) => p.type === 'text') as
      | { text?: string }
      | undefined;

    return Response.json({
      sessionId: session.data.id,
      response: textPart?.text ?? null,
      parts: result.data?.parts ?? [],
    });
  } catch (error) {
    console.error('Prompt error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    return Response.json({ error: message, stack }, { status: 500 });
  }
}
