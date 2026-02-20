/**
 * Remote Agents Dashboard
 *
 * Chat UI for the Orchestrator AIChatAgent. Lets the user send messages to
 * the Orchestrator (which manages remote coding agents), and shows a live
 * sidebar of running agents polled via @callable RPC.
 */
import React, {
  useState,
  useEffect,
  useRef,
  FormEvent,
  KeyboardEvent,
} from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentEntry {
  sandboxId: string;
  sessionId: string;
  branch: string;
  status: 'launching' | 'running' | 'done' | 'failed' | 'aborted';
  launchedAt: string;
}

type AgentMap = Record<string, AgentEntry>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: AgentEntry['status']): string {
  switch (status) {
    case 'launching':
      return '#f59e0b';
    case 'running':
      return '#22c55e';
    case 'done':
      return '#6b7280';
    case 'failed':
      return '#ef4444';
    case 'aborted':
      return '#f97316';
    default:
      return '#6b7280';
  }
}

function statusLabel(status: AgentEntry['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatElapsed(iso: string): string {
  try {
    const elapsed = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (elapsed < 60) return `${elapsed}s ago`;
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    return `${Math.floor(elapsed / 3600)}h ago`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AgentBadge({ status }: { status: AgentEntry['status'] }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: statusColor(status),
        background: statusColor(status) + '20',
        borderRadius: 4,
        padding: '2px 7px',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: statusColor(status),
          display: 'inline-block',
          ...(status === 'launching' || status === 'running'
            ? { animation: 'pulse 1.5s ease-in-out infinite' }
            : {}),
        }}
      />
      {statusLabel(status)}
    </span>
  );
}

function AgentSidebar({
  agents,
  loading,
}: {
  agents: AgentMap;
  loading: boolean;
}) {
  const entries = Object.entries(agents);

  return (
    <aside
      style={{
        width: 260,
        flexShrink: 0,
        background: '#111',
        borderRight: '1px solid #222',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          padding: '14px 16px 10px',
          borderBottom: '1px solid #222',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 12, color: '#888', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Agents
        </span>
        {loading && (
          <span style={{ fontSize: 10, color: '#555', fontStyle: 'italic' }}>
            refreshing…
          </span>
        )}
      </div>

      {entries.length === 0 ? (
        <div
          style={{
            padding: '20px 16px',
            color: '#555',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          No agents running.
          <br />
          <span style={{ color: '#444' }}>
            Ask the orchestrator to launch one.
          </span>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {entries.map(([issueId, agent]) => (
            <li
              key={issueId}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #1a1a1a',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 4,
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: '#e4e4e7',
                  }}
                >
                  {issueId}
                </span>
                <AgentBadge status={agent.status} />
              </div>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 2 }}>
                {agent.branch}
              </div>
              <div style={{ fontSize: 11, color: '#444' }}>
                {formatTime(agent.launchedAt)} · {formatElapsed(agent.launchedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

interface MessagePart {
  type: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
}

function MessageBubble({ role, parts }: { role: string; parts: MessagePart[] }) {
  const isUser = role === 'user';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
        padding: '0 16px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: '#555',
          marginBottom: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {isUser ? 'You' : 'Orchestrator'}
      </div>
      <div
        style={{
          maxWidth: '80%',
          background: isUser ? '#2563eb' : '#1a1a1a',
          borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
          padding: '10px 14px',
          fontSize: 14,
          lineHeight: 1.55,
          color: '#e4e4e7',
          wordBreak: 'break-word',
          border: isUser ? 'none' : '1px solid #222',
        }}
      >
        {parts.map((part, i) => {
          if (part.type === 'text') {
            return (
              <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
                {part.text}
              </span>
            );
          }
          if (part.type === 'tool-invocation') {
            const state = part.state ?? 'calling';
            const isDone = state === 'result';
            return (
              <div
                key={i}
                style={{
                  marginTop: 8,
                  padding: '6px 10px',
                  background: '#0d0d0d',
                  borderRadius: 6,
                  border: '1px solid #2a2a2a',
                  fontFamily: 'monospace',
                  fontSize: 12,
                }}
              >
                <div style={{ color: isDone ? '#22c55e' : '#f59e0b', marginBottom: 2 }}>
                  {isDone ? '✓' : '⟳'} {part.toolName}
                </div>
                {!isDone && part.input !== undefined && (
                  <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>
                    {JSON.stringify(part.input, null, 2).slice(0, 200)}
                  </div>
                )}
                {isDone && part.output !== undefined && (
                  <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
                    {typeof part.output === 'string'
                      ? part.output.slice(0, 300)
                      : JSON.stringify(part.output).slice(0, 300)}
                  </div>
                )}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        textAlign: 'center',
      }}
    >
      <div>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🤖</div>
        <h2
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: '#e4e4e7',
            marginBottom: 8,
          }}
        >
          Remote Agents Orchestrator
        </h2>
        <p
          style={{
            color: '#555',
            fontSize: 14,
            lineHeight: 1.6,
            maxWidth: 380,
          }}
        >
          Chat with the orchestrator to launch and manage remote coding agents.
          Try:
        </p>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '16px auto 0',
            maxWidth: 340,
            textAlign: 'left',
          }}
        >
          {[
            '"What issues are ready to work on?"',
            '"Launch an agent for AGE-42"',
            '"Check on AGE-99"',
            '"Stop all agents"',
          ].map((hint) => (
            <li
              key={hint}
              style={{
                background: '#1a1a1a',
                border: '1px solid #222',
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: 8,
                fontSize: 13,
                color: '#888',
                fontStyle: 'italic',
              }}
            >
              {hint}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  const [agents, setAgents] = useState<AgentMap>({});
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Connect to the Orchestrator AIChatAgent DO
  const agent = useAgent({ agent: 'Orchestrator', name: 'main' });

  const { messages, sendMessage, status } = useAgentChat({ agent });

  // Poll agent list via @callable RPC every 5 seconds
  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (!agent) return;
      setSidebarLoading(true);
      try {
        // agent.call() calls @callable RPC methods
        const result = await (agent as any).call('listAgents', []);
        if (!cancelled) setAgents(result ?? {});
      } catch {
        // Ignore — connection may not be ready yet
      } finally {
        if (!cancelled) setSidebarLoading(false);
      }
    }

    refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [agent]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text) return;
    setInputValue('');
    sendMessage({
      role: 'user',
      parts: [{ type: 'text', text }],
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = inputValue.trim();
      if (!text) return;
      setInputValue('');
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text }],
      });
    }
  }

  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: '#0a0a0a',
        color: '#e4e4e7',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* Agent Sidebar */}
      <AgentSidebar agents={agents} loading={sidebarLoading} />

      {/* Chat Panel */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <header
          style={{
            padding: '12px 20px',
            borderBottom: '1px solid #1a1a1a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
            background: '#0a0a0a',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <span style={{ fontWeight: 700, fontSize: 15, color: '#e4e4e7' }}>
              Orchestrator
            </span>
            <span
              style={{
                fontSize: 11,
                color: '#555',
                background: '#1a1a1a',
                border: '1px solid #222',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              remote-agents
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isStreaming && (
              <span style={{ fontSize: 12, color: '#f59e0b' }}>
                ● responding…
              </span>
            )}
            <span
              style={{
                fontSize: 11,
                color: '#444',
              }}
            >
              {Object.keys(agents).length} agent{Object.keys(agents).length !== 1 ? 's' : ''}
            </span>
          </div>
        </header>

        {/* Messages */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingTop: 20,
            paddingBottom: 8,
          }}
        >
          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                parts={(msg.parts ?? []) as MessagePart[]}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: '12px 16px 16px',
            borderTop: '1px solid #1a1a1a',
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            flexShrink: 0,
            background: '#0a0a0a',
          }}
        >
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the orchestrator…"
            rows={1}
            disabled={isStreaming}
            style={{
              flex: 1,
              resize: 'none',
              background: '#111',
              border: '1px solid #222',
              borderRadius: 8,
              color: '#e4e4e7',
              fontSize: 14,
              padding: '10px 14px',
              outline: 'none',
              lineHeight: 1.5,
              minHeight: 42,
              maxHeight: 140,
              overflowY: 'auto',
              fontFamily: 'inherit',
              opacity: isStreaming ? 0.5 : 1,
            }}
          />
          <button
            type="submit"
            disabled={isStreaming || !inputValue.trim()}
            style={{
              background: '#2563eb',
              border: 'none',
              borderRadius: 8,
              color: '#fff',
              cursor: isStreaming || !inputValue.trim() ? 'not-allowed' : 'pointer',
              fontSize: 14,
              fontWeight: 600,
              opacity: isStreaming || !inputValue.trim() ? 0.4 : 1,
              padding: '10px 18px',
              flexShrink: 0,
              height: 42,
              transition: 'opacity 0.15s',
            }}
          >
            Send
          </button>
        </form>
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        * { box-sizing: border-box; }
        body { margin: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
      `}</style>
    </div>
  );
}
