/**
 * Remote Agents Worker — Entrypoint & Router
 *
 * Spins up a Sandbox container running opencode serve, then routes:
 *
 *  GET  /                        → opencode web UI
 *  /agents/orchestrator/*        → Orchestrator DO (WebSocket chat)
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
import { routeAgentRequest } from 'agents';
import { AGENT_PROFILES, getConfig, getServer } from './config.js';
import { handleDispatch } from './handlers/dispatch.js';
import { handleKickoff } from './handlers/kickoff.js';
import { handleMessages, handleSessionStatus, handleFollowUp, handleListSessions, handleSnapshot } from './handlers/session.js';
import { handleExec } from './handlers/exec.js';
import { handleWorkspaceSave, handleWorkspaceList, handleWorkspaceDelete, handleWorkspaceFile } from './handlers/workspace.js';
import { Sandbox as SandboxDO } from './sandbox.js';

// Re-export DO classes (required by wrangler bindings)
export { Sandbox } from './sandbox.js';
export { Orchestrator } from './orchestrator.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, 'opencode');

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- Internal: container forwarder → Sandbox DO (append-event) ---
    // The forwarder process in the container POSTs here; we forward to the Sandbox DO.
    if (request.method === 'POST' && url.pathname === '/internal/append-event') {
      return (sandbox as unknown as SandboxDO).fetch(request);
    }

    // --- Public: browser polls for buffered session events ---
    const eventsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/events$/);
    if (request.method === 'GET' && eventsMatch) {
      const sessionId = eventsMatch[1];
      const since = Number(url.searchParams.get('since') ?? '0');
      const rows = (sandbox as unknown as SandboxDO).getEvents(sessionId, since);
      return Response.json({ events: rows });
    }

    // --- Voice signaling routes → Orchestrator DO ---
    // /voice/* routes need to reach the Orchestrator DO's onRequest() handler
    // for SFU signaling (SDP exchange) and WebSocket adapter connections.
    if (url.pathname.startsWith('/voice/')) {
      const orchestratorId = env.Orchestrator.idFromName('main');
      const orchestrator = env.Orchestrator.get(orchestratorId);
      return orchestrator.fetch(request);
    }

    // --- Orchestrator DO (WebSocket chat agent) ---
    // Routes: /agents/orchestrator/* via CF Agents SDK
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
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

    // Opencode web UI proxy (explicit route, not catch-all)
    if (url.pathname.startsWith('/opencode')) {
      const server = await getServer(sandbox, env);
      return proxyToOpencode(request, sandbox, server);
    }

    // Everything else: static assets served by Workers Assets (vite-built SPA)
    // Return 404 for unmatched API routes
    if (url.pathname.startsWith('/api/')) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // For non-API routes, let the assets binding serve the SPA
    // The vite plugin adds the __STATIC_CONTENT binding automatically
    return new Response('Not found', { status: 404 });
  },
};
