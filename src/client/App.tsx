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

interface AgentEvent {
  id: string;
  event: { type: string; properties?: Record<string, unknown> };
  timestamp: string;
}

interface AgentSession {
  label: string;
  events: AgentEvent[];
}

// =============================================================================
// AGENT EVENT PANEL
// =============================================================================

const EVENT_ICONS: Record<string, string> = {
  'file.edited': '📝',
  'command.executed': '⚡',
  'message.updated': '💬',
  'session.idle': '✅',
  'session.error': '❌',
  'session.status': '⏳',
};

function AgentPanel({
  sessions,
  activeTab,
  onTabChange,
}: {
  sessions: Map<string, AgentSession>;
  activeTab: string | null;
  onTabChange: (id: string) => void;
}) {
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const sessionIds = Array.from(sessions.keys());

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, activeTab]);

  if (sessionIds.length === 0) return null;

  const currentTab = activeTab && sessions.has(activeTab) ? activeTab : sessionIds[0];
  const currentSession = sessions.get(currentTab)!;

  return (
    <div className="agent-panel">
      <div className="agent-panel-header">
        <span className="agent-panel-title">Agents</span>
        <div className="agent-tabs">
          {sessionIds.map(id => (
            <button
              key={id}
              className={`agent-tab ${currentTab === id ? 'active' : ''}`}
              onClick={() => onTabChange(id)}
              title={sessions.get(id)!.label}
            >
              {sessions.get(id)!.label.slice(0, 10)}
            </button>
          ))}
        </div>
      </div>
      <div className="agent-events">
        {currentSession.events.map(e => (
          <div key={e.id} className={`agent-event agent-event-${e.event.type.replace('.', '-')}`}>
            <span className="agent-event-icon">{EVENT_ICONS[e.event.type] ?? '▸'}</span>
            <span className="agent-event-body">
              <span className="agent-event-type">{e.event.type}</span>
              {e.event.properties && Object.keys(e.event.properties).length > 0 && (
                <span className="agent-event-props">
                  {formatEventProps(e.event.type, e.event.properties)}
                </span>
              )}
            </span>
            <span className="agent-event-time">
              {new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
        ))}
        <div ref={eventsEndRef} />
      </div>
    </div>
  );
}

function formatEventProps(type: string, props: Record<string, unknown>): string {
  if (type === 'file.edited') return String(props.file ?? '');
  if (type === 'command.executed') return String(props.name ?? '');
  if (type === 'session.error') {
    const err = props.error as any;
    return err?.message ?? err?.data?.message ?? JSON.stringify(err ?? '').slice(0, 60);
  }
  if (type === 'session.status') return String(props.status ?? '');
  return '';
}

// =============================================================================
// VOICE HOOK — WebRTC via Cloudflare Calls SFU
// =============================================================================

/**
 * Voice hook that uses WebRTC (via Cloudflare Calls SFU) for audio transport.
 *
 * Two RTCPeerConnections:
 *   1. Listener (recvonly) — receives TTS audio from SFU
 *   2. Mic (sendrecv via addTrack) — publishes mic audio to SFU
 *
 * Signaling flow:
 *   1. POST /voice/tts/publish       — DO publishes TTS track to SFU
 *   2. POST /voice/tts/connect       — Browser subscribes to TTS track (SDP exchange)
 *   3. POST /voice/stt/connect       — Browser publishes mic track (SDP exchange)
 *   4. POST /voice/stt/start-forwarding — SFU starts forwarding mic audio to DO
 *
 * The Agent SDK WebSocket is used only for voice control messages (voice:start,
 * voice:stop, voice:started, voice:stopped, voice:transcript, voice:tts:done, etc.)
 */
function useVoice(agent: ReturnType<typeof useAgent>, connected: boolean) {
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [transport, setTransport] = useState<'webrtc' | 'websocket' | null>(null);
  const [transcript, setTranscript] = useState('');

  // WebRTC refs
  const listenerPcRef = useRef<RTCPeerConnection | null>(null);
  const micPcRef = useRef<RTCPeerConnection | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);

  // Fallback: raw PCM WebSocket refs (kept for non-SFU mode)
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef(0);
  const ttsBufferRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  const mediaStreamFallbackRef = useRef<MediaStream | null>(null);

  // Drain queued TTS audio buffers through AudioContext (fallback mode only)
  const drainTtsQueue = useCallback(() => {
    if (isPlayingRef.current) return;
    isPlayingRef.current = true;

    const ctx = playbackCtxRef.current;
    if (!ctx || ttsBufferRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    while (ttsBufferRef.current.length > 0) {
      const pcmBuffer = ttsBufferRef.current.shift()!;
      const int16 = new Int16Array(pcmBuffer);
      if (int16.length === 0) continue;

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

  // -------------------------------------------------------------------------
  // WebRTC start flow
  // -------------------------------------------------------------------------

  // --- API helpers (same pattern as reference: realtime-examples/ai-tts-stt/src/web/services/api.ts) ---

  const apiTtsPublish = async (): Promise<void> => {
    const res = await fetch('/voice/tts/publish', { method: 'POST' });
    if (!res.ok) throw new Error(`TTS publish failed: ${res.status} ${await res.text()}`);
    console.log('[WebRTC] TTS published');
  };

  /** Send SDP offer, get back sessionDescription answer (extracted from SFU response).
   * Handles requiresImmediateRenegotiation: if SFU needs a second offer, does the
   * renegotiate round-trip transparently. */
  const apiTtsConnect = async (
    listenerPc: RTCPeerConnection,
    sessionDescription: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> => {
    const res = await fetch('/voice/tts/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDescription }),
    });
    if (res.status === 400) throw new Error('Session has not been published yet.');
    if (!res.ok) throw new Error(`TTS connect failed: ${res.status} ${await res.text()}`);
    const answer = await res.json() as any;
    console.log('[WebRTC] raw tts connect response:', JSON.stringify(answer));

    // Happy path: SFU returned a real SDP answer directly
    if (answer?.sessionDescription?.sdp) {
      const sd = answer.sessionDescription;
      if (!sd.type) sd.type = 'answer';
      return sd as RTCSessionDescriptionInit;
    }

    // requiresImmediateRenegotiation: true — need a second offer/answer round-trip
    if (answer?.requiresImmediateRenegotiation) {
      console.log('[WebRTC] requiresImmediateRenegotiation — creating second offer for renegotiation');
      const reOffer = await listenerPc.createOffer();
      await listenerPc.setLocalDescription(reOffer);

      const reRes = await fetch('/voice/tts/renegotiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionDescription: reOffer }),
      });
      if (!reRes.ok) throw new Error(`TTS renegotiate failed: ${reRes.status} ${await reRes.text()}`);
      const reAnswer = await reRes.json() as any;
      console.log('[WebRTC] renegotiate response:', JSON.stringify(reAnswer));
      const sd = reAnswer?.sessionDescription ?? reAnswer;
      if (!sd?.sdp) throw new Error(`TTS renegotiate: missing SDP. Keys: ${Object.keys(reAnswer || {}).join(', ')}`);
      if (!sd.type) sd.type = 'answer';
      return sd as RTCSessionDescriptionInit;
    }

    // Unexpected: no SDP and no requiresImmediateRenegotiation flag
    throw new Error(`TTS connect: missing SDP in response. Keys: ${Object.keys(answer).join(', ')}`);
  };

  /** Send SDP offer for mic, get back sessionDescription answer */
  const apiSttConnect = async (sessionDescription: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
    const res = await fetch('/voice/stt/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDescription }),
    });
    if (!res.ok) throw new Error(`STT connect failed: ${res.status} ${await res.text()}`);
    const answer = await res.json() as any;
    console.log('[WebRTC] raw stt connect response:', JSON.stringify(answer));
    const sd = answer.sessionDescription ?? answer;
    if (!sd || !sd.sdp) throw new Error(`STT connect: missing SDP in response. Keys: ${Object.keys(answer).join(', ')}`);
    if (!sd.type) sd.type = 'answer';
    return sd as RTCSessionDescriptionInit;
  };

  const apiSttStartForwarding = async (): Promise<void> => {
    const res = await fetch('/voice/stt/start-forwarding', { method: 'POST' });
    if (!res.ok) console.warn('[WebRTC] Start forwarding:', res.status, await res.text());
  };

  const apiSttStopForwarding = async (): Promise<void> => {
    const res = await fetch('/voice/stt/stop-forwarding', { method: 'POST' });
    if (!res.ok) console.warn('[WebRTC] Stop forwarding:', res.status);
  };

  // --- WebRTC setup (same pattern as reference: realtime-examples/ai-tts-stt/src/web/app.ts) ---

  const startWebRTC = useCallback(async () => {
    try {
      // 1. Tell server to start voice pipeline
      agent.send(JSON.stringify({ type: 'voice:start' }));

      // 2. Publish TTS track from DO to SFU
      await apiTtsPublish();

      // 3. Listener PeerConnection — receive TTS audio (exact same as reference startWebRTCPull)
      const listenerPc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      });
      listenerPc.addTransceiver('audio', { direction: 'recvonly' });
      listenerPcRef.current = listenerPc;

      listenerPc.ontrack = (event: RTCTrackEvent) => {
        console.log('[WebRTC] Received TTS audio track');
        const audio = document.createElement('audio');
        audio.srcObject = event.streams[0];
        audio.autoplay = true;
        // Must be in the DOM for autoplay to work in browsers
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.play().catch((e) => console.warn('[WebRTC] Audio play() rejected:', e));
        audioElementRef.current = audio;
      };

      // Create offer, exchange SDP, set remote answer — exact reference pattern
      const listenerOffer = await listenerPc.createOffer();
      await listenerPc.setLocalDescription(listenerOffer);
      const ttsAnswer = await apiTtsConnect(listenerPc, listenerOffer);
      await listenerPc.setRemoteDescription(ttsAnswer);
      console.log('[WebRTC] TTS listener connected');

      // 4. Mic PeerConnection — publish mic audio (exact same as reference STTService.startRecording)
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 2,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = micStream;

      const micPc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      });
      micStream.getTracks().forEach(track => micPc.addTrack(track, micStream));
      micPcRef.current = micPc;

      // Monitor mic connection state
      micPc.onconnectionstatechange = () => {
        console.log('[WebRTC] Mic connection state:', micPc.connectionState);
      };

      // Create offer, exchange SDP, set remote answer
      const micOffer = await micPc.createOffer();
      await micPc.setLocalDescription(micOffer);
      const sttAnswer = await apiSttConnect(micOffer);
      await micPc.setRemoteDescription(sttAnswer);
      console.log('[WebRTC] Mic SDP exchange complete');

      // 5. Wait for mic PeerConnection to connect, then start forwarding
      await new Promise<void>((resolve, reject) => {
        if (micPc.connectionState === 'connected') { resolve(); return; }
        const timeout = setTimeout(() => reject(new Error('Mic WebRTC connection timeout')), 15000);
        const handler = () => {
          if (micPc.connectionState === 'connected') {
            clearTimeout(timeout);
            micPc.removeEventListener('connectionstatechange', handler);
            resolve();
          } else if (micPc.connectionState === 'failed') {
            clearTimeout(timeout);
            micPc.removeEventListener('connectionstatechange', handler);
            reject(new Error('Mic WebRTC connection failed'));
          }
        };
        micPc.addEventListener('connectionstatechange', handler);
      });

      console.log('[WebRTC] Mic connected, starting forwarding');
      await apiSttStartForwarding();

      setTransport('webrtc');
      console.log('[WebRTC] Voice fully active via WebRTC');
    } catch (e) {
      console.error('[WebRTC] Setup failed:', e);
      throw e;
    }
  }, [agent]);

  // -------------------------------------------------------------------------
  // Fallback: raw PCM WebSocket start flow
  // -------------------------------------------------------------------------

  const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(3200);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const samples = input[0];
      const remaining = this._buffer.length - this._offset;
      if (samples.length >= remaining) {
        this._buffer.set(samples.subarray(0, remaining), this._offset);
        this.port.postMessage(this._buffer.slice());
        const leftover = samples.length - remaining;
        this._offset = 0;
        if (leftover > 0) {
          this._buffer.set(samples.subarray(remaining), 0);
          this._offset = leftover;
        }
      } else {
        this._buffer.set(samples, this._offset);
        this._offset += samples.length;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

  const startFallback = useCallback(async () => {
    // Get mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStreamFallbackRef.current = stream;

    const audioCtx = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioCtx;

    if (!workletUrlRef.current) {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      workletUrlRef.current = URL.createObjectURL(blob);
    }
    await audioCtx.audioWorklet.addModule(workletUrlRef.current);

    const source = audioCtx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
    workletNodeRef.current = workletNode;

    workletNode.port.onmessage = (event: MessageEvent) => {
      const float32: Float32Array = event.data;
      const actualRate = audioCtx.sampleRate;
      const ratio = actualRate / 16000;
      const outLength = Math.floor(float32.length / ratio);
      const int16 = new Int16Array(outLength);
      for (let i = 0; i < outLength; i++) {
        const srcIndex = i * ratio;
        const low = Math.floor(srcIndex);
        const high = Math.min(low + 1, float32.length - 1);
        const frac = srcIndex - low;
        const sample = float32[low] * (1 - frac) + float32[high] * frac;
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }
      const copy = new ArrayBuffer(int16.byteLength);
      new Int16Array(copy).set(int16);
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(copy);
      }
    };

    source.connect(workletNode);
    workletNode.connect(audioCtx.destination);

    if (!playbackCtxRef.current || playbackCtxRef.current.state === 'closed') {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    nextPlayTimeRef.current = 0;

    agent.send(JSON.stringify({ type: 'voice:start' }));
    setTransport('websocket');
  }, [agent]);

  // -------------------------------------------------------------------------
  // Start / Stop voice
  // -------------------------------------------------------------------------

  const startVoice = useCallback(async () => {
    if (!connected || voiceActive) return;
    setVoiceConnecting(true);

    try {
      // Try WebRTC first
      await startWebRTC();
    } catch (e) {
      console.warn('[Voice] WebRTC failed, falling back to raw PCM WebSocket:', e);
      try {
        await startFallback();
      } catch (fallbackError) {
        console.error('[Voice] Fallback also failed:', fallbackError);
        setVoiceConnecting(false);
        return;
      }
    }
  }, [connected, voiceActive, startWebRTC, startFallback]);

  const stopVoice = useCallback(() => {
    // Stop WebRTC connections
    if (listenerPcRef.current) {
      listenerPcRef.current.close();
      listenerPcRef.current = null;
    }
    if (micPcRef.current) {
      micPcRef.current.close();
      micPcRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.srcObject = null;
      audioElementRef.current.remove();
      audioElementRef.current = null;
    }

    // Stop forwarding (fire and forget)
    apiSttStopForwarding().catch(() => {});

    // Stop fallback audio
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (mediaStreamFallbackRef.current) {
      mediaStreamFallbackRef.current.getTracks().forEach(t => t.stop());
      mediaStreamFallbackRef.current = null;
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
    setTransport(null);
    setTranscript('');
    ttsBufferRef.current = [];
  }, [agent]);

  // Handle voice-related messages from server
  const handleVoiceMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'voice:started':
        setVoiceActive(true);
        setVoiceConnecting(false);
        if (data.transport) setTransport(data.transport);
        break;
      case 'voice:stopped':
        setVoiceActive(false);
        setVoiceConnecting(false);
        setTransport(null);
        setTranscript('');
        break;
      case 'voice:transcript':
        setTranscript(data.text || '');
        break;
      case 'voice:tts:done':
        break;
      case 'voice:tts:clear':
        // Barge-in: stop TTS playback
        if (audioElementRef.current) {
          // For WebRTC, the audio element plays the stream — nothing to clear
          // (SFU stops sending audio from the DO side)
        }
        // For fallback mode, clear the buffer
        ttsBufferRef.current = [];
        if (playbackCtxRef.current) {
          nextPlayTimeRef.current = 0;
        }
        break;
      case 'voice:error':
        console.error('Voice error:', data.error);
        setVoiceActive(false);
        setVoiceConnecting(false);
        setTransport(null);
        break;
    }
  }, []);

  // Handle binary messages (TTS audio — fallback mode only)
  const handleBinaryMessage = useCallback((data: ArrayBuffer) => {
    if (transport === 'webrtc') return; // WebRTC handles playback natively
    ttsBufferRef.current.push(data);
    drainTtsQueue();
  }, [transport, drainTtsQueue]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (listenerPcRef.current) listenerPcRef.current.close();
      if (micPcRef.current) micPcRef.current.close();
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
      if (mediaStreamFallbackRef.current) mediaStreamFallbackRef.current.getTracks().forEach(t => t.stop());
      if (audioContextRef.current) audioContextRef.current.close();
      if (workletUrlRef.current) URL.revokeObjectURL(workletUrlRef.current);
    };
  }, []);

  return {
    voiceActive,
    voiceConnecting,
    transport,
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
  const [agentSessions, setAgentSessions] = useState<Map<string, AgentSession>>(new Map());
  const [activeSessionTab, setActiveSessionTab] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamingContentRef = useRef<string>('');
  const streamingIdRef = useRef<string>('');
  const rpcIdCounter = useRef(0);
  const pendingRpcs = useRef<Map<string, (result: any) => void>>(new Map());

  const voiceHandlersRef = useRef<{
    handleVoiceMessage: (data: any) => void;
    handleBinaryMessage: (data: ArrayBuffer) => void;
  }>({ handleVoiceMessage: () => {}, handleBinaryMessage: () => {} });

  const handleMessageRef = useRef<(data: any) => void>(() => {});

  const agent = useAgent({
    agent: 'orchestrator',
    name: 'main',
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onMessage: (event: MessageEvent) => {
      // Binary message = TTS audio (fallback mode only)
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

        handleMessageRef.current(data);
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

      case 'agent:event': {
        const { sessionId, label, event } = data as {
          sessionId: string;
          label: string;
          event: { type: string; properties?: Record<string, unknown> };
        };
        setAgentSessions(prev => {
          const next = new Map(prev);
          const session = next.get(sessionId) ?? { label, events: [] };
          const newEvent: AgentEvent = {
            id: `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            event,
            timestamp: new Date().toISOString(),
          };
          next.set(sessionId, { ...session, events: [...session.events.slice(-199), newEvent] });
          return next;
        });
        setActiveSessionTab(prev => prev ?? sessionId);
        break;
      }
    }
  }, []);

  // Keep handleMessageRef in sync
  useEffect(() => {
    handleMessageRef.current = handleMessage;
  }, [handleMessage]);

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
          {voice.voiceActive && voice.transport && (
            <span className="transport-badge">{voice.transport === 'webrtc' ? 'WebRTC' : 'PCM'}</span>
          )}
          {agentState?.messageCount ? (
            <span className="msg-count">{agentState.messageCount} msgs</span>
          ) : null}
          <button className="clear-btn" onClick={clearChat} title="Clear chat">
            Clear
          </button>
        </div>
      </header>

      <div className={`workspace ${agentSessions.size > 0 ? 'split' : ''}`}>
        <div className="chat-pane">
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

        {agentSessions.size > 0 && (
          <AgentPanel
            sessions={agentSessions}
            activeTab={activeSessionTab}
            onTabChange={setActiveSessionTab}
          />
        )}
      </div>
    </div>
  );
}
