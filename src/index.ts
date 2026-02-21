/**
 * Remote Agents Worker — Entrypoint & Router
 *
 * Spins up a Sandbox container running opencode serve, then routes:
 *
 *  GET  /                        → opencode web UI
 *  POST /api/dispatch            → dispatch lb issue to remote agent
 *  POST /api/kickoff             → raw prompt (no lb)
 *  GET  /api/session/:id         → session status
 *  GET  /api/session/:id/messages → conversation history
 *  POST /api/session/:id/prompt  → follow-up prompt
 *  POST /api/session/:id/snapshot → capture messages to DO SQLite
 *  POST /api/exec                → run command in container
 *  GET  /api/sessions            → list all sessions
 *  GET  /api/profiles            → list agent profiles
 *  POST /api/workspace/save      → save workspace to R2
 *  GET  /api/workspace/list      → list R2 workspaces
 *  DELETE /api/workspace/:name   → delete R2 workspace
 *  GET  /api/workspace/file/*    → read file from container
 */
import { getSandbox } from '@cloudflare/sandbox';
import { proxyToOpencode } from '@cloudflare/sandbox/opencode';
import { AGENT_PROFILES, getConfig, getServer } from './config.js';
import { handleDispatch } from './handlers/dispatch.js';
import { handleKickoff } from './handlers/kickoff.js';
import { handleMessages, handleSessionStatus, handleFollowUp, handleListSessions, handleSnapshot } from './handlers/session.js';
import { handleExec } from './handlers/exec.js';
import { handleWorkspaceSave, handleWorkspaceList, handleWorkspaceDelete, handleWorkspaceFile } from './handlers/workspace.js';

// Re-export Sandbox DO class (required by wrangler binding)
export { Sandbox } from './sandbox.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- API routes ---

    if (request.method === 'POST' && url.pathname === '/api/dispatch') {
      return handleDispatch(sandbox, env, request);
    }

    if (request.method === 'POST' && url.pathname === '/api/kickoff') {
      return handleKickoff(sandbox, env, request);
    }

    const messagesMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/messages$/);
    if (request.method === 'GET' && messagesMatch) {
      return handleMessages(sandbox, env, messagesMatch[1]);
    }

    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (request.method === 'GET' && sessionMatch) {
      return handleSessionStatus(sandbox, env, sessionMatch[1]);
    }

    const promptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (request.method === 'POST' && promptMatch) {
      return handleFollowUp(sandbox, env, promptMatch[1], request);
    }

    if (request.method === 'POST' && url.pathname === '/api/exec') {
      return handleExec(sandbox, request);
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return handleListSessions(sandbox, env);
    }

    const snapshotMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/snapshot$/);
    if (request.method === 'POST' && snapshotMatch) {
      return handleSnapshot(sandbox, env, snapshotMatch[1]);
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/save') {
      return handleWorkspaceSave(sandbox, env, request);
    }

    if (request.method === 'GET' && url.pathname === '/api/workspace/list') {
      return handleWorkspaceList(env);
    }

    const deleteWorkspaceMatch = url.pathname.match(/^\/api\/workspace\/([^/]+)$/);
    if (request.method === 'DELETE' && deleteWorkspaceMatch) {
      return handleWorkspaceDelete(env, deleteWorkspaceMatch[1]);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/workspace/file/')) {
      const filePath = url.pathname.slice('/api/workspace/file/'.length);
      return handleWorkspaceFile(sandbox, filePath);
    }

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
    const server = await getServer(sandbox, env);
    return proxyToOpencode(request, sandbox, server);
  },
};
