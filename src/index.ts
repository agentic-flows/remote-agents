/**
 * Worker entrypoint for the remote-agents system.
 *
 * Routes requests to the appropriate Durable Object:
 * - Orchestrator (AIChatAgent) — chat + agent management
 * - Sandbox — container lifecycle (managed by orchestrator tools)
 *
 * The `routeAgentRequest` function from the agents SDK handles
 * WebSocket upgrades and routing to the correct DO instance.
 *
 * Static assets (dashboard SPA) are served by Cloudflare Workers Assets
 * via the Vite plugin — no manual HTML serving needed.
 *
 * API routes:
 * - GET /health      → health check JSON
 * - /agents/*        → Durable Object routing (WebSocket + RPC)
 */
import { routeAgentRequest } from 'agents';
import { assertRequiredSecrets } from './secrets.js';

// Re-export Durable Object classes so wrangler can find them
export { Sandbox } from '@cloudflare/sandbox';
export { Orchestrator } from './orchestrator.js';

// Import env types
import './env.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Agent routes require secrets — fail fast with a clear error
    assertRequiredSecrets(env);

    // routeAgentRequest handles:
    //   /agents/Orchestrator/:name  → Orchestrator DO (chat WebSocket)
    //   /agents/Sandbox/:name       → Sandbox DO
    // Returns null for non-agent routes.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // 404 for anything else (static assets handled by Workers Assets)
    return new Response('Not found', { status: 404 });
  },
};
