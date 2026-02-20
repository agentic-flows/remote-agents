/**
 * Remote Agents Worker
 *
 * Spins up a Sandbox container running opencode serve, then:
 *
 * 1. Web UI    — GET /        → opencode web experience
 * 2. Kickoff   — POST /api/kickoff  → fire-and-forget task (returns sessionId)
 * 3. Status    — GET  /api/session/:id → check session status + messages
 * 4. Prompt    — POST /api/session/:id/prompt → send follow-up (async)
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

/**
 * Get an opencode SDK client for the sandbox.
 * createOpencode starts `opencode serve` if not already running.
 */
async function getClient(sandbox: ReturnType<typeof getSandbox>, env: Env) {
  return createOpencode<OpencodeClient>(sandbox, {
    directory: WORK_DIR,
    config: getConfig(env),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- API routes ---

    // POST /api/kickoff — clone repo, create session, fire prompt async
    if (request.method === 'POST' && url.pathname === '/api/kickoff') {
      return handleKickoff(sandbox, env, request);
    }

    // GET /api/session/:id — check session status + messages
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (request.method === 'GET' && sessionMatch) {
      return handleSessionStatus(sandbox, env, sessionMatch[1]);
    }

    // POST /api/session/:id/prompt — send follow-up prompt (async)
    const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (request.method === 'POST' && promptMatch) {
      return handleFollowUp(sandbox, env, promptMatch[1], request);
    }

    // GET /api/sessions — list all sessions
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return handleListSessions(sandbox, env);
    }

    // Everything else: proxy to the opencode web UI
    const server = await createOpencodeServer(sandbox, {
      directory: WORK_DIR,
      config: getConfig(env),
    });
    return proxyToOpencode(request, sandbox, server);
  },
};

// ---------------------------------------------------------------------------
// POST /api/kickoff
// Body: { "text": "...", "repo"?: "...", "branch"?: "..." }
// Returns: { sessionId }
// ---------------------------------------------------------------------------
async function handleKickoff(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      text?: string;
      repo?: string;
      branch?: string;
    };
    if (!body.text) {
      return Response.json({ error: 'Missing "text" in request body' }, { status: 400 });
    }

    const repo = body.repo || REPO_URL;

    // Clone the repo (clean workspace first if it already exists)
    await sandbox.exec(`rm -rf ${WORK_DIR} && mkdir -p ${WORK_DIR}`);
    await sandbox.gitCheckout(repo, { targetDir: WORK_DIR });

    // Set up git identity + gh auth
    if (env.GIT_AUTHOR_NAME) {
      await sandbox.exec(`git config --global user.name "${env.GIT_AUTHOR_NAME}"`);
    }
    if (env.GIT_AUTHOR_EMAIL) {
      await sandbox.exec(`git config --global user.email "${env.GIT_AUTHOR_EMAIL}"`);
    }
    await sandbox.exec(`git config --global --add safe.directory ${WORK_DIR}`);
    if (env.GH_TOKEN) {
      await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token`);
    }

    // Checkout branch if specified
    if (body.branch) {
      const check = await sandbox.exec(
        `cd ${WORK_DIR} && git ls-remote --exit-code --heads origin "${body.branch}" 2>/dev/null && echo EXISTS || echo NEW`,
      );
      if (check.stdout?.includes('EXISTS')) {
        await sandbox.exec(`cd ${WORK_DIR} && git checkout -b "${body.branch}" "origin/${body.branch}"`);
      } else {
        await sandbox.exec(`cd ${WORK_DIR} && git checkout -b "${body.branch}"`);
      }
    }

    // Start opencode serve + get SDK client
    const { client } = await getClient(sandbox, env);

    // Create session
    const session = await client.session.create({
      body: { title: 'Remote Agent' },
      query: { directory: WORK_DIR },
    });
    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    // Fire prompt async — agent works in background
    await client.session.promptAsync({
      path: { id: session.data.id },
      query: { directory: WORK_DIR },
      body: {
        parts: [{ type: 'text', text: body.text }],
      },
    });

    return Response.json({
      sessionId: session.data.id,
      status: 'kicked off',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/session/:id
// Returns session info + recent messages
// ---------------------------------------------------------------------------
async function handleSessionStatus(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
): Promise<Response> {
  try {
    const { client } = await getClient(sandbox, env);

    // List all sessions and find ours (session.get has a URL mismatch in this SDK version)
    const [sessions, status] = await Promise.all([
      client.session.list({ query: { directory: WORK_DIR } }),
      client.session.status({ query: { directory: WORK_DIR } }),
    ]);

    const session = (sessions.data as any[])?.find(
      (s: { id: string }) => s.id === sessionId,
    ) ?? null;

    return Response.json({
      session,
      status: status.data ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/session/:id/prompt
// Body: { "text": "..." }
// Sends a follow-up prompt (async)
// ---------------------------------------------------------------------------
async function handleFollowUp(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  sessionId: string,
  request: Request,
): Promise<Response> {
  try {
    const body = (await request.json()) as { text?: string };
    if (!body.text) {
      return Response.json({ error: 'Missing "text"' }, { status: 400 });
    }

    const { client } = await getClient(sandbox, env);

    await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: WORK_DIR },
      body: {
        parts: [{ type: 'text', text: body.text }],
      },
    });

    return Response.json({ status: 'sent' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /api/sessions
// List all sessions
// ---------------------------------------------------------------------------
async function handleListSessions(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
): Promise<Response> {
  try {
    const { client } = await getClient(sandbox, env);
    const sessions = await client.session.list();
    return Response.json(sessions.data ?? []);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
