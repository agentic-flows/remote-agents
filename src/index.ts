/**
 * Worker entrypoint for the remote-agents system.
 *
 * Routes requests to the appropriate Durable Object:
 * - Orchestrator (AIChatAgent) — chat + agent management
 * - Sandbox — container lifecycle (managed by orchestrator tools)
 *
 * The `routeAgentRequest` function from the agents SDK handles
 * WebSocket upgrades and routing to the correct DO instance.
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
    // Fail fast if required secrets are missing
    assertRequiredSecrets(env);

    // routeAgentRequest handles:
    //   /agents/Orchestrator/:name  → Orchestrator DO (chat WebSocket)
    //   /agents/Sandbox/:name       → Sandbox DO
    // Returns null for non-agent routes.
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Fallback: return a simple status page
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // Default: redirect to the dashboard (will be served by AGE-173)
    return new Response(
      `<!DOCTYPE html>
<html>
<head><title>Remote Agents</title></head>
<body>
  <h1>Remote Agents Orchestrator</h1>
  <p>The orchestrator is running. Connect via the dashboard or WebSocket.</p>
  <p>Agent endpoint: <code>/agents/Orchestrator/main</code></p>
  <p>Health check: <a href="/health">/health</a></p>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html' } },
    );
  },
};
