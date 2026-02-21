/**
 * Session handlers: status, messages, follow-up, snapshot, list.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { WORK_DIR, DEFAULT_MODEL, getClient } from '../config.js';
import { Sandbox } from '../sandbox.js';

/**
 * GET /api/session/:id/messages
 * Try live container first; fall back to persisted messages in DO SQLite.
 */
export async function handleMessages(
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

/**
 * GET /api/session/:id — session info + status.
 * Try live container first; fall back to persisted session log.
 */
export async function handleSessionStatus(
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

/**
 * POST /api/session/:id/prompt — send follow-up (async).
 * Body: { "text": "...", "model"?: { ... } }
 */
export async function handleFollowUp(
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

/**
 * GET /api/sessions — list all sessions.
 * Returns persisted session logs from DO SQLite (always available).
 * Also includes live sessions from the container when it's running.
 */
export async function handleListSessions(
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

/**
 * POST /api/session/:id/snapshot — capture messages to persistent storage.
 * Call this while the container is alive to save messages before it dies.
 */
export async function handleSnapshot(
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
