/**
 * Extended Sandbox Durable Object with SQLite session persistence.
 *
 * Subclasses the base Sandbox from @cloudflare/sandbox to add:
 * - session_log table: tracks dispatched sessions (survives hibernation)
 * - session_messages table: captured conversation messages
 */
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';

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
