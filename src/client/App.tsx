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

// =============================================================================
// AUDIO WORKLET PROCESSOR (inline as a blob URL)
// =============================================================================

const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // input[0] is Float32Array at whatever sampleRate the context uses
      // We need to post it to the main thread for resampling + sending
      this.port.postMessage(input[0].slice());
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

function createWorkletBlobUrl(): string {
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

// =============================================================================
// AUDIO UTILS
// =============================================================================

/**
 * Resample Float32 audio from srcRate to dstRate (simple linear interpolation).
 * Returns Int16Array (PCM16).
 */
function resampleAndConvertToInt16(
  float32: Float32Array,
  srcRate: number,
  dstRate: number,
): Int16Array {
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(float32.length / ratio);
  const int16 = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, float32.length - 1);
    const frac = srcIndex - low;
    const sample = float32[low] * (1 - frac) + float32[high] * frac;
    // Clamp and convert to int16
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }

  return int16;
}

/**
 * Convert Int16Array PCM to ArrayBuffer for sending over WebSocket.
 */
function int16ToArrayBuffer(int16: Int16Array): ArrayBuffer {
  // Copy to a clean ArrayBuffer to avoid SharedArrayBuffer issues
  const copy = new ArrayBuffer(int16.byteLength);
  new Int16Array(copy).set(int16);
  return copy;
}

// =============================================================================
// VOICE HOOK
// =============================================================================

function useVoice(agent: ReturnType<typeof useAgent>, connected: boolean) {
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [transcript, setTranscript] = useState('');

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);

  // TTS playback
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const ttsBufferRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);

  // Drain queued TTS audio buffers through AudioContext
  const drainTtsQueue = useCallback(() => {
    if (isPlayingRef.current) return;
    isPlayingRef.current = true;

    const ctx = playbackCtxRef.current;
    if (!ctx || ttsBufferRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    // Process all queued buffers
    while (ttsBufferRef.current.length > 0) {
      const pcmBuffer = ttsBufferRef.current.shift()!;
      const int16 = new Int16Array(pcmBuffer);
      if (int16.length === 0) continue;

      // Create AudioBuffer (24kHz mono — matches TTS output)
      const audioBuffer = ctx.createBuffer(1, int16.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < int16.length; i++) {
        channelData[i] = int16[i] / 32768;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const now = ctx.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
    }

    isPlayingRef.current = false;
  }, []);

  const startVoice = useCallback(async () => {
    if (!connected || voiceActive) return;
    setVoiceConnecting(true);

    try {
      // Get mic access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: { ideal: 16000 },
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // Create AudioContext for capture
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      // Load AudioWorklet
      if (!workletUrlRef.current) {
        workletUrlRef.current = createWorkletBlobUrl();
      }
      await audioCtx.audioWorklet.addModule(workletUrlRef.current);

      // Connect: mic → worklet
      const source = audioCtx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (event: MessageEvent) => {
        const float32: Float32Array = event.data;
        // Resample from audioContext.sampleRate (may not be exactly 16k) to 16000
        const actualRate = audioCtx.sampleRate;
        const int16 = resampleAndConvertToInt16(float32, actualRate, 16000);
        const buffer = int16ToArrayBuffer(int16);

        // Send raw PCM bytes as binary WebSocket frame
        if (agent.readyState === WebSocket.OPEN) {
          agent.send(buffer);
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioCtx.destination); // needed to keep worklet alive

      // Create playback context for TTS
      if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
        playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
      }
      nextPlayTimeRef.current = 0;

      // Tell server to start voice mode
      agent.send(JSON.stringify({ type: 'voice:start' }));
    } catch (e) {
      console.error('Failed to start voice:', e);
      setVoiceConnecting(false);
      return;
    }
  }, [agent, connected, voiceActive]);

  const stopVoice = useCallback(() => {
    // Stop mic
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Tell server to stop
    if (agent.readyState === WebSocket.OPEN) {
      agent.send(JSON.stringify({ type: 'voice:stop' }));
    }

    setVoiceActive(false);
    setVoiceConnecting(false);
    setTranscript('');
    ttsBufferRef.current = [];
  }, [agent]);

  // Handle voice-related messages from server
  const handleVoiceMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'voice:started':
        setVoiceActive(true);
        setVoiceConnecting(false);
        break;
      case 'voice:stopped':
        setVoiceActive(false);
        setVoiceConnecting(false);
        setTranscript('');
        break;
      case 'voice:transcript':
        setTranscript(data.text || '');
        break;
      case 'voice:tts:done':
        // TTS finished — could add visual indicator here
        break;
      case 'voice:error':
        console.error('Voice error:', data.error);
        setVoiceActive(false);
        setVoiceConnecting(false);
        break;
    }
  }, []);

  // Handle binary messages (TTS audio)
  const handleBinaryMessage = useCallback((data: ArrayBuffer) => {
    ttsBufferRef.current.push(data);
    drainTtsQueue();
  }, [drainTtsQueue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (workletUrlRef.current) {
        URL.revokeObjectURL(workletUrlRef.current);
      }
    };
  }, []);

  return {
    voiceActive,
    voiceConnecting,
    transcript,
    startVoice,
    stopVoice,
    handleVoiceMessage,
    handleBinaryMessage,
  };
}

// =============================================================================
// APP
// =============================================================================

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

  // We need a ref to the voice hook's handlers so we can call them from onMessage
  const voiceHandlersRef = useRef<{
    handleVoiceMessage: (data: any) => void;
    handleBinaryMessage: (data: ArrayBuffer) => void;
  }>({ handleVoiceMessage: () => {}, handleBinaryMessage: () => {} });

  const agent = useAgent({
    agent: 'orchestrator',
    name: 'main',
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onMessage: (event: MessageEvent) => {
      // Binary message = TTS audio
      if (event.data instanceof ArrayBuffer) {
        voiceHandlersRef.current.handleBinaryMessage(event.data);
        return;
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buf => {
          voiceHandlersRef.current.handleBinaryMessage(buf);
        });
        return;
      }

      try {
        const data = JSON.parse(event.data);

        // Voice messages
        if (typeof data.type === 'string' && data.type.startsWith('voice:')) {
          voiceHandlersRef.current.handleVoiceMessage(data);
          return;
        }

        handleMessage(data);
      } catch {
        // non-JSON message
      }
    },
  });

  const voice = useVoice(agent as any, connected);

  // Keep the ref in sync
  useEffect(() => {
    voiceHandlersRef.current = {
      handleVoiceMessage: voice.handleVoiceMessage,
      handleBinaryMessage: voice.handleBinaryMessage,
    };
  }, [voice.handleVoiceMessage, voice.handleBinaryMessage]);

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

  const toggleVoice = useCallback(() => {
    if (voice.voiceActive || voice.voiceConnecting) {
      voice.stopVoice();
    } else {
      voice.startVoice();
    }
  }, [voice]);

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
        {messages.length === 0 && !voice.voiceActive && (
          <div className="empty-state">
            <p className="empty-title">Chat with the Orchestrator</p>
            <p className="empty-hint">
              Try: "What issues are ready?" or "List sessions" or "Kickoff a research task"
            </p>
            <p className="empty-hint">
              Or click the mic button to talk.
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

      {/* Voice transcript overlay */}
      {voice.voiceActive && voice.transcript && (
        <div className="voice-transcript">
          <span className="voice-transcript-text">{voice.transcript}</span>
        </div>
      )}

      <footer className="input-area">
        <button
          className={`mic-btn ${voice.voiceActive ? 'active' : ''} ${voice.voiceConnecting ? 'connecting' : ''}`}
          onClick={toggleVoice}
          disabled={!connected}
          title={voice.voiceActive ? 'Stop voice' : 'Start voice'}
        >
          {voice.voiceConnecting ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="32">
                <animate attributeName="stroke-dashoffset" from="32" to="0" dur="1s" repeatCount="indefinite" />
              </circle>
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="1" width="6" height="14" rx="3" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="23" x2="12" y2="19" />
            </svg>
          )}
        </button>
        <textarea
          ref={inputRef}
          className="input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            voice.voiceActive
              ? 'Voice mode active — speak or type...'
              : isStreaming
                ? 'Waiting for response...'
                : 'Message the Orchestrator...'
          }
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
