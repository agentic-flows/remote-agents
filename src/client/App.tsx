import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAgent } from 'agents/react';
import './styles.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  streaming?: boolean;
}

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [agentState, setAgentState] = useState<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingContentRef = useRef<string>('');
  const streamingIdRef = useRef<string>('');
  const rpcIdCounter = useRef(0);
  const pendingRpcs = useRef<Map<string, (result: any) => void>>(new Map());

  const agent = useAgent({
    agent: 'orchestrator',
    name: 'main',
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onMessage: (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch {
        // non-JSON message
      }
    },
  });

  const handleMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'cf_agent_state':
        setAgentState(data.state);
        break;

      case 'chat:stream:start':
        streamingContentRef.current = '';
        streamingIdRef.current = data.id;
        setIsStreaming(true);
        setMessages(prev => [
          ...prev,
          {
            id: data.id,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            streaming: true,
          },
        ]);
        break;

      case 'chat:stream:chunk':
        streamingContentRef.current += data.content;
        setMessages(prev =>
          prev.map(m =>
            m.id === streamingIdRef.current
              ? { ...m, content: streamingContentRef.current }
              : m,
          ),
        );
        break;

      case 'chat:stream:end':
        setMessages(prev =>
          prev.map(m =>
            m.id === streamingIdRef.current
              ? { ...m, content: data.content, streaming: false }
              : m,
          ),
        );
        setIsStreaming(false);
        streamingIdRef.current = '';
        streamingContentRef.current = '';
        break;

      case 'rpc': {
        const resolver = pendingRpcs.current.get(data.id);
        if (resolver) {
          resolver(data);
          pendingRpcs.current.delete(data.id);
        }
        break;
      }
    }
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on load
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendRpc = useCallback(
    (method: string, args: any[]): Promise<any> => {
      return new Promise(resolve => {
        const id = `rpc-${++rpcIdCounter.current}`;
        pendingRpcs.current.set(id, resolve);
        agent.send(JSON.stringify({ type: 'rpc', id, method, args }));
      });
    },
    [agent],
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    // Call doChat — the streaming events will handle the assistant response
    sendRpc('doChat', [{ message: text }]);
  }, [input, isStreaming, sendRpc]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = useCallback(() => {
    setMessages([]);
    sendRpc('clearHistory', []);
  }, [sendRpc]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Remote Agents</h1>
          <span className="subtitle">Orchestrator</span>
        </div>
        <div className="header-right">
          <span className={`status-dot ${connected ? 'connected' : 'disconnected'}`} />
          <span className="status-text">{connected ? 'Connected' : 'Disconnected'}</span>
          {agentState?.messageCount ? (
            <span className="msg-count">{agentState.messageCount} msgs</span>
          ) : null}
          <button className="clear-btn" onClick={clearChat} title="Clear chat">
            Clear
          </button>
        </div>
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">Chat with the Orchestrator</p>
            <p className="empty-hint">
              Try: "What issues are ready?" or "List sessions" or "Kickoff a research task"
            </p>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-header">
              <span className="message-role">{msg.role === 'user' ? 'You' : 'Orchestrator'}</span>
              <span className="message-time">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="message-content">
              {msg.content || (msg.streaming ? <span className="typing">Thinking...</span> : '')}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </main>

      <footer className="input-area">
        <textarea
          ref={inputRef}
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'Waiting for response...' : 'Message the Orchestrator...'}
          disabled={isStreaming || !connected}
          rows={1}
        />
        <button
          className="send-btn"
          onClick={sendMessage}
          disabled={!input.trim() || isStreaming || !connected}
        >
          Send
        </button>
      </footer>
    </div>
  );
}
