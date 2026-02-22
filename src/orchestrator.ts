/**
 * Orchestrator — Voice + Text chat agent DO for managing remote coding agents.
 *
 * Extends VoiceAgent from core/ which provides the full voice pipeline:
 *   - STT (Deepgram Flux) + TTS (Cloudflare Aura) lifecycle
 *   - Flux state machine (StartOfTurn, EagerEndOfTurn, TurnResumed, EndOfTurn)
 *   - LLM inference with streaming into TTS
 *   - Conversation history, echo cancellation, barge-in
 *
 * This class adds:
 *   - WebRTC voice via Cloudflare Calls SFU (Opus codec, jitter buffering, echo cancellation)
 *   - Fallback to raw PCM WebSocket transport if SFU credentials not configured
 *   - Text chat via @callable doChat RPC (same tools, shared history)
 *   - All Orchestrator tools (container lifecycle, session mgmt, workspace, lb)
 *
 * WebRTC voice flow:
 *   Browser mic → WebRTC (Opus) → SFU → WebSocket adapter → DO (48kHz stereo PCM)
 *     → resample to 16kHz mono → STT (Flux) → LLM → TTS (Aura, 24kHz mono)
 *     → resample to 48kHz stereo → WebSocket adapter → SFU → WebRTC (Opus) → browser speaker
 */

import { getSandbox } from '@cloudflare/sandbox';
import { type Connection, callable } from 'agents';
import { VoiceAgent } from '../core/voice-agent/voice.js';
import type { VoiceAgentState } from '../core/voice-agent/voice.js';
import type { AnyToolDefinition } from '../core/infer/tools/types.js';
import type { Message } from '../core/infer/inferutils/common.js';
import { infer } from '../core/infer/inferutils/core.js';
import { WORK_DIR, DEFAULT_MODEL, AGENT_PROFILES, getClient } from './config.js';
import { setupWorkspace, saveWorkspace, restoreWorkspace, resolveWorkspaceKey } from './workspace.js';
import { Sandbox } from './sandbox.js';
import { listIssues, getIssue, updateIssueState, createIssue, formatIssueList, formatIssueDetail } from './linear.js';
import type { Config } from '@opencode-ai/sdk';

// SFU integration
import {
  SfuClient,
  buildWsCallbackUrl,
  encodePcmForSfu,
  extractPcmFromSfuPacket,
  type SfuConfig,
} from '../core/integrations/sfu/index.js';
import { toMono16kFromStereo48k, resample24kToStereo48k } from '../core/integrations/sfu/sfu-audio.js';

// =============================================================================
// TYPES
// =============================================================================

interface OrchestratorState extends VoiceAgentState {
  initialized: boolean;
  messageCount: number;
  lastActivity: string | null;
}

/** SFU session state persisted in DO storage to survive hibernation */
interface SfuVoiceState {
  // TTS publish path (DO → SFU → browser)
  ttsSessionId: string;       // SFU session for the TTS track
  ttsAdapterId: string;       // WebSocket adapter ID for TTS
  ttsTrackName: string;       // Track name published to SFU

  // TTS player session (browser → SFU subscribe)
  ttsPlayerSessionId?: string;  // Player SFU session created during connect

  // STT subscribe path (browser → SFU → DO)
  sttSessionId: string;       // SFU session for the mic track
  sttTrackName: string;       // Mic track name from browser
  sttAdapterId?: string;      // WebSocket adapter forwarding mic audio to DO
  sttCallbackUrl: string;     // WebSocket callback URL for SFU → DO audio
}

// Chunk size for TTS audio sent to SFU (matches reference example)
const TTS_BUFFER_CHUNK_SIZE = 8192;

// =============================================================================
// SYSTEM PROMPT
// =============================================================================

const SYSTEM_PROMPT = `You are a voice-controlled command dispatcher for coding agents.

RULES — NO EXCEPTIONS:
- Maximum 1 sentence per response. Usually just 2-5 words is enough.
- Do not explain anything. Do not confirm unless something is genuinely ambiguous.
- Do not describe what you're about to do. Just do it, then say what happened.
- Never say "I", "Sure", "Got it", "Of course", "I'll", or any filler.
- Bad: "Sure! I'll dispatch that issue to a remote agent right away."
- Good: "Dispatching AGE-42." then call the tool.
- After a tool succeeds: one short fact. "Done. Container starting."
- After a tool fails: one short fact. "Failed — no repo URL."

TOOLS:
- linear_issues(stateNames?, stateTypes?) — list Linear issues (no container needed)
- linear_show(issueId) — full issue details
- linear_update_status(issueId, status) — update issue state
- linear_create(title, description?) — create new issue
- create_repo(name, description?) — create a private GitHub repo under agentic-flows/, returns repoUrl
- dispatch_issue(issueId, repo) — launch container agent on a Linear issue
- kickoff(text, repo?) — launch container agent with a raw prompt
- check_session(sessionId) — poll agent status
- send_message(sessionId, text) — send instructions to running agent
- exec_command / read_file — debug inside container`;

// =============================================================================
// ORCHESTRATOR
// =============================================================================

export class Orchestrator extends VoiceAgent<Env, OrchestratorState> {
  // Voice state
  private voiceActive = false;
  private _voiceStreamingMsgId: string | null = null;
  private _sfuStateCache: SfuVoiceState | null = null;

  // ---------------------------------------------------------------------------
  // sfuState: persisted in DO storage to survive hibernation
  // ---------------------------------------------------------------------------

  private get sfuState(): SfuVoiceState | null {
    return this._sfuStateCache;
  }

  private set sfuState(value: SfuVoiceState | null) {
    this._sfuStateCache = value;
    // Fire-and-forget persistence — hibernation-safe
    if (value === null) {
      this.ctx.storage.delete('sfuState').catch(() => {});
    } else {
      this.ctx.storage.put('sfuState', value).catch(() => {});
    }
  }

  private async loadSfuState(): Promise<void> {
    if (this._sfuStateCache !== undefined) return; // already loaded or explicitly null
    const stored = await this.ctx.storage.get<SfuVoiceState>('sfuState');
    this._sfuStateCache = stored ?? null;
  }

  initialState: OrchestratorState = {
    callSid: null,
    callerPhone: null,
    initialized: false,
    messageCount: 0,
    lastActivity: null,
  };

  // ---------------------------------------------------------------------------
  // VoiceAgent hooks
  // ---------------------------------------------------------------------------

  protected getGreeting(): string { return ''; }
  protected getSystemPrompt(): string { return SYSTEM_PROMPT; }
  protected override getTools(): AnyToolDefinition[] { return this.buildTools(); }

  // Browser needs linear16/24kHz (not Twilio mulaw/8kHz)
  protected override getTTSEncoding(): string { return 'linear16'; }
  protected override getTTSSampleRate(): string { return '24000'; }
  protected override getTTSSpeaker(): string { return 'asteria'; }

  // ---------------------------------------------------------------------------
  // SFU configuration helpers
  // ---------------------------------------------------------------------------

  private hasSfuCredentials(): boolean {
    return !!(this.env.REALTIME_SFU_APP_ID && this.env.REALTIME_SFU_BEARER_TOKEN);
  }

  private getSfuConfig(): SfuConfig {
    return {
      sfuApiBase: this.env.SFU_API_BASE || 'https://rtc.live.cloudflare.com/v1',
      appId: this.env.REALTIME_SFU_APP_ID!,
      bearerToken: this.env.REALTIME_SFU_BEARER_TOKEN!,
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP request handler — SFU signaling + WebSocket adapters
  // ---------------------------------------------------------------------------

  /**
   * Override fetch() to intercept SFU WebSocket upgrade requests before
   * partyserver (the base class) can swallow them.
   *
   * partyserver's fetch() (partyserver/dist/index.js:394) intercepts ALL
   * WebSocket upgrades and treats them as partykit client connections —
   * it never calls onRequest() for WebSocket requests. This means the SFU's
   * callback connections to /voice/tts/subscribe and /voice/stt/sfu-subscribe
   * would be silently mishandled without this override.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (url.pathname.endsWith('/voice/tts/subscribe')) {
        await this.loadSfuState();
        return this.handleTtsSubscribe();
      }
      if (url.pathname.endsWith('/voice/stt/sfu-subscribe')) {
        await this.loadSfuState();
        return this.handleSttSfuSubscribe();
      }
    }
    return super.fetch(request);
  }

  /**
   * Handle non-WebSocket HTTP requests to the Orchestrator DO.
   * The Agent SDK calls this for requests that aren't WebSocket upgrades.
   *
   * Routes:
   *   POST /voice/tts/publish     — Publish TTS track to SFU (called during voice:start)
   *   POST /voice/tts/connect     — Browser subscribes to TTS track (SDP exchange)
   *   POST /voice/stt/connect     — Browser publishes mic track (SDP exchange)
   *   POST /voice/stt/start-forwarding — Start SFU → DO audio forwarding
   *   POST /voice/stt/stop-forwarding  — Stop forwarding
   *   WS   /voice/tts/subscribe   — SFU connects here to receive TTS audio
   *   WS   /voice/stt/sfu-subscribe — SFU connects here to deliver mic audio
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Load persisted SFU state on every request (survives DO hibernation)
    await this.loadSfuState();

    // Note: WebSocket upgrades are handled in fetch() before partyserver sees them.
    // onRequest() is only called for non-WebSocket HTTP requests.

    // HTTP POST endpoints for signaling
    if (request.method === 'POST') {
      if (path.endsWith('/voice/tts/publish')) {
        return this.handleTtsPublish(request);
      }
      if (path.endsWith('/voice/tts/connect')) {
        return this.handleTtsConnect(request);
      }
      if (path.endsWith('/voice/tts/renegotiate')) {
        return this.handleTtsRenegotiate(request);
      }
      if (path.endsWith('/voice/stt/connect')) {
        return this.handleSttConnect(request);
      }
      if (path.endsWith('/voice/stt/start-forwarding')) {
        return this.handleSttStartForwarding();
      }
      if (path.endsWith('/voice/stt/stop-forwarding')) {
        return this.handleSttStopForwarding();
      }
    }

    return new Response('Not Found', { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // TTS SFU Handlers (DO → SFU → browser)
  // ---------------------------------------------------------------------------

  /**
   * WebSocket upgrade: SFU connects here to receive TTS audio from the DO.
   * The DO pushes encoded SFU packets (48kHz stereo PCM) to this WebSocket.
   */
  private handleTtsSubscribe(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    // Don't use Agent SDK's acceptWebSocket — these are raw SFU connections
    server.accept();
    // Tag the socket for identification
    (server as any).__sfuRole = 'tts-subscriber';

    // Store reference so TTS audio can be pushed to it
    this._ttsSfuSocket = server;

    server.addEventListener('close', () => {
      console.log('[SFU/TTS] Subscriber WebSocket closed');
      if (this._ttsSfuSocket === server) this._ttsSfuSocket = null;
    });
    server.addEventListener('error', (e: any) => {
      console.error('[SFU/TTS] Subscriber WebSocket error:', e);
    });

    console.log('[SFU/TTS] Subscriber WebSocket connected');
    return new Response(null, { status: 101, webSocket: client });
  }

  /** TTS SFU subscriber WebSocket */
  private _ttsSfuSocket: WebSocket | null = null;

  /**
   * POST /voice/tts/publish — Create SFU WebSocket adapter for TTS.
   * The SFU will connect back to our /voice/tts/subscribe endpoint to receive audio.
   */
  private async handleTtsPublish(request: Request): Promise<Response> {
    if (!this.hasSfuCredentials()) {
      return new Response('SFU credentials not configured', { status: 500 });
    }

    // If stale sfuState exists (e.g. DO hibernated mid-session), clean it up and re-publish.
    if (this.sfuState?.ttsAdapterId) {
      console.log('[SFU/TTS] Stale TTS adapter detected — cleaning up before re-publishing');
      try {
        const sfu = new SfuClient(this.getSfuConfig());
        await sfu.closeWebSocketAdapter(this.sfuState.ttsAdapterId);
      } catch {}
      this.sfuState = null;
      this._ttsSfuSocket = null;
    }

    const trackName = `orchestrator-tts-${Date.now()}`;
    const subscribeUrl = buildWsCallbackUrl(request, '/voice/tts/subscribe');

    console.log(`[SFU/TTS] Publishing track "${trackName}" with callback: ${subscribeUrl}`);

    try {
      const sfu = new SfuClient(this.getSfuConfig());
      const { sessionId, adapterId, json } = await sfu.pushTrackFromWebSocket(trackName, subscribeUrl);

      // Initialize or update SFU state
      this.sfuState = {
        ...this.sfuState!,
        ttsSessionId: sessionId,
        ttsAdapterId: adapterId,
        ttsTrackName: trackName,
      };

      console.log(`[SFU/TTS] Published. Session: ${sessionId}, Adapter: ${adapterId}`);

      // Wait for SFU to connect back on /voice/tts/subscribe before returning.
      // The SFU calls back asynchronously after pushTrackFromWebSocket. If we return
      // immediately, the browser may call /voice/tts/connect before _ttsSfuSocket is set,
      // causing pullRemoteTrackToPlayer to return requiresImmediateRenegotiation: true.
      // Waiting here ensures the track is live by the time the browser calls connect.
      await new Promise<void>((resolve, reject) => {
        if (this._ttsSfuSocket) { resolve(); return; }
        const timeout = setTimeout(() => reject(new Error('SFU subscriber timeout after 5s')), 5000);
        const check = setInterval(() => {
          if (this._ttsSfuSocket) {
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          }
        }, 50);
      });

      console.log('[SFU/TTS] Subscriber WebSocket connected — track is live');
      return Response.json({ sessionId, adapterId, trackName, ...json });
    } catch (e: any) {
      console.error('[SFU/TTS] Publish failed:', e.message);
      return new Response(`SFU publish failed: ${e.message}`, { status: 500 });
    }
  }

  /**
   * POST /voice/tts/connect — Browser subscribes to TTS audio track.
   * Creates a player SFU session and pulls the TTS track.
   * If SFU returns requiresImmediateRenegotiation: true, stores the player session ID
   * and returns the response as-is so the browser can do the renegotiation round-trip.
   */
  private async handleTtsConnect(request: Request): Promise<Response> {
    if (!this.sfuState?.ttsSessionId) {
      return new Response('TTS not published yet', { status: 400 });
    }

    try {
      const { sessionDescription } = (await request.json()) as any;
      if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

      const sfu = new SfuClient(this.getSfuConfig());
      const { sessionId: playerSessionId } = await sfu.createSession();
      const sfuAnswer = await sfu.pullRemoteTrackToPlayer(
        playerSessionId,
        this.sfuState.ttsSessionId,
        this.sfuState.ttsTrackName,
        sessionDescription,
      );

      // Always store the player session ID — needed for renegotiation
      this.sfuState = { ...this.sfuState, ttsPlayerSessionId: playerSessionId };

      console.log(`[SFU/TTS] Browser connect to TTS track via player session ${playerSessionId}`);
      console.log(`[SFU/TTS] requiresImmediateRenegotiation: ${sfuAnswer?.requiresImmediateRenegotiation}, sessionDescription present: ${!!sfuAnswer?.sessionDescription}`);

      // If SFU gave us a direct answer (track already live), normalize and return it
      if (sfuAnswer?.sessionDescription?.sdp) {
        if (!sfuAnswer.sessionDescription.type) sfuAnswer.sessionDescription.type = 'answer';
        return Response.json(sfuAnswer);
      }

      // requiresImmediateRenegotiation: true — return as-is; browser will renegotiate
      return Response.json(sfuAnswer);
    } catch (e: any) {
      console.error('[SFU/TTS] Connect failed:', e.message);
      return new Response(`SFU connect failed: ${e.message}`, { status: 500 });
    }
  }

  /**
   * POST /voice/tts/renegotiate — Browser sends a new offer after requiresImmediateRenegotiation.
   * Calls PUT /sessions/{playerSessionId}/renegotiate on the SFU and returns the real SDP answer.
   */
  private async handleTtsRenegotiate(request: Request): Promise<Response> {
    if (!this.sfuState?.ttsPlayerSessionId) {
      return new Response('No player session to renegotiate. Call /voice/tts/connect first.', { status: 400 });
    }

    try {
      const { sessionDescription } = (await request.json()) as any;
      if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

      const sfu = new SfuClient(this.getSfuConfig());
      const result = await sfu.renegotiateSession(this.sfuState.ttsPlayerSessionId, sessionDescription);

      console.log(`[SFU/TTS] Renegotiation complete for player session ${this.sfuState.ttsPlayerSessionId}`);
      return Response.json(result);
    } catch (e: any) {
      console.error('[SFU/TTS] Renegotiate failed:', e.message);
      return new Response(`SFU renegotiate failed: ${e.message}`, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // STT SFU Handlers (browser → SFU → DO)
  // ---------------------------------------------------------------------------

  /**
   * WebSocket upgrade: SFU connects here to deliver mic audio to the DO.
   * The DO receives encoded SFU packets (48kHz stereo PCM), resamples to 16kHz mono, and feeds to STT.
   */
  private handleSttSfuSubscribe(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    (server as any).__sfuRole = 'stt-subscriber';

    server.addEventListener('message', (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer && this.voiceActive) {
        this.handleSfuMicAudio(event.data);
      }
    });
    server.addEventListener('close', () => {
      console.log('[SFU/STT] Audio subscriber WebSocket closed');
    });
    server.addEventListener('error', (e: any) => {
      console.error('[SFU/STT] Audio subscriber WebSocket error:', e);
    });

    console.log('[SFU/STT] Audio subscriber WebSocket connected');
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * POST /voice/stt/connect — Browser publishes mic via WebRTC.
   * Creates an SFU session and auto-discovers the mic track.
   */
  private async handleSttConnect(request: Request): Promise<Response> {
    if (!this.hasSfuCredentials()) {
      return new Response('SFU credentials not configured', { status: 500 });
    }

    try {
      const { sessionDescription } = (await request.json()) as any;
      if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

      const sfu = new SfuClient(this.getSfuConfig());
      const { sessionId } = await sfu.createSession();
      const { json: publishResponse, audioTrackName } = await sfu.addTracksAutoDiscover(sessionId, sessionDescription);

      if (!audioTrackName) {
        throw new Error('Failed to get microphone track name from SFU response');
      }

      const sttCallbackUrl = buildWsCallbackUrl(request, '/voice/stt/sfu-subscribe');

      // Store STT SFU state
      this.sfuState = {
        ...this.sfuState!,
        sttSessionId: sessionId,
        sttTrackName: audioTrackName,
        sttCallbackUrl,
      };

      console.log(`[SFU/STT] Mic connected. Session: ${sessionId}, Track: ${audioTrackName}`);
      // Ensure sessionDescription has type: 'answer' — SFU may omit it
      if (publishResponse?.sessionDescription && !publishResponse.sessionDescription.type) {
        publishResponse.sessionDescription.type = 'answer';
      }
      return Response.json(publishResponse);
    } catch (e: any) {
      console.error('[SFU/STT] Connect failed:', e.message);
      return new Response(`SFU STT connect failed: ${e.message}`, { status: 500 });
    }
  }

  /**
   * POST /voice/stt/start-forwarding — Tell SFU to forward mic audio to our DO via WebSocket.
   * Must be called after the browser's RTCPeerConnection reaches "connected" state.
   */
  private async handleSttStartForwarding(): Promise<Response> {
    if (!this.sfuState?.sttSessionId || !this.sfuState?.sttTrackName || !this.sfuState?.sttCallbackUrl) {
      return new Response('STT not connected yet. Call /voice/stt/connect first.', { status: 400 });
    }
    if (this.sfuState.sttAdapterId) {
      return new Response('Forwarding already active', { status: 200 });
    }

    try {
      const sfu = new SfuClient(this.getSfuConfig());
      const { adapterId } = await sfu.pullTrackToWebSocket(
        this.sfuState.sttSessionId,
        this.sfuState.sttTrackName,
        this.sfuState.sttCallbackUrl,
      );

      if (adapterId) {
        this.sfuState.sttAdapterId = adapterId;
        console.log(`[SFU/STT] Forwarding started. Adapter: ${adapterId}`);
      }

      return new Response('Forwarding started', { status: 200 });
    } catch (e: any) {
      console.error('[SFU/STT] Start forwarding failed:', e.message);
      return new Response(`Start forwarding failed: ${e.message}`, { status: 500 });
    }
  }

  /**
   * POST /voice/stt/stop-forwarding — Stop SFU → DO mic audio forwarding.
   */
  private async handleSttStopForwarding(): Promise<Response> {
    if (!this.sfuState?.sttAdapterId) {
      return new Response('Forwarding not active', { status: 200 });
    }

    try {
      const sfu = new SfuClient(this.getSfuConfig());
      await sfu.closeWebSocketAdapter(this.sfuState.sttAdapterId);
      this.sfuState.sttAdapterId = undefined;
      console.log('[SFU/STT] Forwarding stopped');
      return new Response('Forwarding stopped', { status: 200 });
    } catch (e: any) {
      console.error('[SFU/STT] Stop forwarding failed:', e.message);
      return new Response(`Stop forwarding failed: ${e.message}`, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // SFU audio processing
  // ---------------------------------------------------------------------------

  /**
   * Process mic audio from SFU: decode protobuf packet, resample 48kHz stereo → 16kHz mono, send to STT.
   */
  private handleSfuMicAudio(packetData: ArrayBuffer): void {
    const pcm48kStereo = extractPcmFromSfuPacket(packetData);
    if (!pcm48kStereo) return;

    // Resample 48kHz stereo → 16kHz mono for STT
    const pcm16kMono = toMono16kFromStereo48k(pcm48kStereo);
    this.sendAudioToSTT(pcm16kMono);
  }

  /**
   * Send TTS audio chunk to the SFU via the TTS subscriber WebSocket.
   * Resamples 24kHz mono → 48kHz stereo and wraps in protobuf packet.
   */
  private sendTtsToSfu(chunk24kMono: Uint8Array): void {
    const ws = this._ttsSfuSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Resample 24kHz mono → 48kHz stereo for SFU
    const stereo48k = resample24kToStereo48k(chunk24kMono.buffer as ArrayBuffer);

    // Send in chunks, wrapped in SFU packet protobuf
    for (let offset = 0; offset < stereo48k.byteLength; offset += TTS_BUFFER_CHUNK_SIZE) {
      const slice = stereo48k.slice(offset, offset + TTS_BUFFER_CHUNK_SIZE);
      ws.send(encodePcmForSfu(slice));
    }
  }

  // ---------------------------------------------------------------------------
  // Voice mode control
  // ---------------------------------------------------------------------------

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    // Binary frames = raw PCM audio from browser mic (fallback transport)
    if (message instanceof ArrayBuffer) {
      if (this.voiceActive && !this.sfuState) {
        // Fallback: raw PCM WebSocket transport (no SFU)
        this.sendAudioToSTT(message);
      }
      return;
    }

    // Try parsing as voice control message
    if (typeof message === 'string') {
      try {
        const data = JSON.parse(message);
        if (data.type === 'voice:start') {
          await this.startBrowserVoice();
          return;
        }
        if (data.type === 'voice:stop') {
          await this.stopBrowserVoice();
          return;
        }
      } catch {
        // Not JSON or not a voice message — fall through
      }
    }

    // Everything else: SDK already handled RPC/state before calling us
  }

  private async startBrowserVoice(): Promise<void> {
    if (this.voiceActive) return;
    console.log('[Voice] Starting browser voice mode');

    const useSfu = this.hasSfuCredentials();
    console.log(`[Voice] Transport: ${useSfu ? 'WebRTC via SFU' : 'raw PCM WebSocket (fallback)'}`);

    try {
      if (useSfu) {
        // SFU transport: TTS audio goes through SFU → WebRTC → browser
        await this.initVoicePipeline({
          onAudioChunk: (chunk: Uint8Array) => {
            this.sendTtsToSfu(chunk);
          },
          onTTSFlushed: () => {
            // Send empty packet to signal end of TTS stream
            const ws = this._ttsSfuSocket;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(encodePcmForSfu(new ArrayBuffer(0)));
            }
            this.broadcast(JSON.stringify({ type: 'voice:tts:done' }));
            // Delay clearing isSpeaking to cover speaker-to-mic round-trip latency.
            // Audio is still playing through speakers when onTTSFlushed fires — clearing
            // immediately lets STT pick up TTS echo as user speech.
            this.clearIsSpeakingAfterDelay();
          },
          onBargeIn: () => {
            this.broadcast(JSON.stringify({ type: 'voice:tts:clear' }));
          },
        });
      } else {
        // Fallback: raw PCM WebSocket transport
        await this.initVoicePipeline({
          onAudioChunk: (chunk: Uint8Array) => {
            const buf = new ArrayBuffer(chunk.byteLength);
            new Uint8Array(buf).set(chunk);
            this.broadcast(buf);
          },
          onTTSFlushed: () => {
            this.broadcast(JSON.stringify({ type: 'voice:tts:done' }));
            // Delay clearing isSpeaking to cover speaker-to-mic round-trip latency.
            this.clearIsSpeakingAfterDelay();
          },
          onBargeIn: () => {
            this.broadcast(JSON.stringify({ type: 'voice:tts:clear' }));
          },
        });
      }
    } catch (e) {
      console.error('[Voice] Pipeline init failed:', e);
      this.broadcast(JSON.stringify({ type: 'voice:error', error: `Voice init failed: ${e}` }));
      return;
    }

    this.voiceActive = true;
    this.broadcast(JSON.stringify({
      type: 'voice:started',
      transport: useSfu ? 'webrtc' : 'websocket',
    }));
    console.log('[Voice] Browser voice mode active');
  }

  private async stopBrowserVoice(): Promise<void> {
    console.log('[Voice] Stopping browser voice mode');
    this.voiceActive = false;
    this.cleanupVoicePipeline();

    // Clean up SFU adapters
    if (this.sfuState && this.hasSfuCredentials()) {
      const sfu = new SfuClient(this.getSfuConfig());
      try {
        if (this.sfuState.sttAdapterId) {
          await sfu.closeWebSocketAdapter(this.sfuState.sttAdapterId);
        }
        if (this.sfuState.ttsAdapterId) {
          await sfu.closeWebSocketAdapter(this.sfuState.ttsAdapterId);
        }
      } catch (e) {
        console.error('[Voice] SFU cleanup error:', e);
      }
      this.sfuState = null;
    }

    // Close SFU WebSockets
    if (this._ttsSfuSocket) {
      try { this._ttsSfuSocket.close(1000, 'Voice stopped'); } catch {}
      this._ttsSfuSocket = null;
    }

    this.broadcast(JSON.stringify({ type: 'voice:stopped' }));
  }

  // ---------------------------------------------------------------------------
  // Voice hooks — emit transcripts and responses to the chat UI
  // ---------------------------------------------------------------------------

  protected override onVoiceTranscript(text: string): void {
    this.broadcast(JSON.stringify({ type: 'voice:transcript', text }));
    this.broadcast(JSON.stringify({
      type: 'chat:message',
      id: `voice-user-${Date.now()}`,
      role: 'user',
      content: text,
    }));
  }

  protected override onVoiceResponseChunk(chunk: string, msgId: string): void {
    // On first chunk, open the streaming message
    if (!this._voiceStreamingMsgId) {
      this._voiceStreamingMsgId = msgId;
      this.broadcast(JSON.stringify({ type: 'chat:stream:start', id: msgId }));
    }
    this.broadcast(JSON.stringify({ type: 'chat:stream:chunk', id: msgId, content: chunk }));
  }

  protected override onVoiceResponse(text: string): void {
    const msgId = this._voiceStreamingMsgId ?? `voice-asst-${Date.now()}`;
    this._voiceStreamingMsgId = null;
    this.broadcast(JSON.stringify({ type: 'chat:stream:end', id: msgId, content: text }));
  }

  // ---------------------------------------------------------------------------
  // Text chat — @callable RPC (lifted from ChatAgent)
  // ---------------------------------------------------------------------------

  @callable({ description: 'Send a chat message (streaming via WebSocket broadcast)' })
  async doChat(input: { message: string }): Promise<{ id: string; role: 'assistant'; content: string; timestamp: string }> {
    const message = typeof input === 'string' ? (input as any) : input.message;
    const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Build messages from shared history (voice + text share the same history)
    const systemMsg: Message = { role: 'system', content: SYSTEM_PROMPT };
    this.history.push({ role: 'user', content: message });

    // Truncate to avoid message limits (keep last 80)
    if (this.history.length > 80) {
      this.history = this.history.slice(-80);
    }

    const messages: Message[] = [systemMsg, ...this.history];

    // Broadcast stream start
    this.broadcast(JSON.stringify({ type: 'chat:stream:start', id: msgId }));

    const tools = this.buildTools();

    const result = await infer({
      env: this.env,
      metadata: { agentId: 'orchestrator', userId: 'chat-user' },
      actionKey: 'testModelConfig',
      messages,
      modelName: 'openai/gpt-4.1',
      tools,
      maxTokens: 8192,
      temperature: 0.3,
      stream: {
        chunk_size: 1,
        onChunk: (chunk: string) => {
          this.broadcast(JSON.stringify({ type: 'chat:stream:chunk', id: msgId, content: chunk }));
        },
      },
    });

    const assistantContent = result.string || '';

    // Broadcast stream end
    this.broadcast(JSON.stringify({ type: 'chat:stream:end', id: msgId, content: assistantContent }));

    // Update shared history
    if (result.toolCallContext?.messages) {
      for (const msg of result.toolCallContext.messages) {
        this.history.push(msg);
      }
    }
    this.history.push({ role: 'assistant', content: assistantContent });

    // Cap history
    if (this.history.length > 80) {
      this.history = this.history.slice(-80);
    }

    this.setState({
      ...this.state,
      messageCount: (this.state.messageCount || 0) + 1,
      lastActivity: new Date().toISOString(),
    });

    return { id: msgId, role: 'assistant', content: assistantContent, timestamp: new Date().toISOString() };
  }

  @callable({ description: 'Get conversation history' })
  getHistory() {
    return this.history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({
        id: `msg_${i}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        timestamp: this.state.lastActivity || new Date().toISOString(),
      }));
  }

  @callable({ description: 'Clear conversation history' })
  clearHistory() {
    this.history = [];
    this.setState({ ...this.state, messageCount: 0 });
    return { cleared: true };
  }

  @callable({ description: 'Health check' })
  ping() {
    return {
      ok: true,
      messageCount: this.state.messageCount || 0,
      voiceActive: this.voiceActive,
      sfuActive: !!this.sfuState,
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Tool definitions
  // ---------------------------------------------------------------------------

  private getSandbox(): ReturnType<typeof getSandbox> {
    return getSandbox(this.env.Sandbox, 'opencode');
  }

  private buildTools(): AnyToolDefinition[] {
    const sandbox = this.getSandbox();
    const env = this.env;

    return [
      // =====================================================================
      // CONTAINER LIFECYCLE
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'dispatch_issue',
          description: 'Dispatch a Linear issue to a remote coding agent. Sets up a container with the repo cloned, lb configured, and sends the issue as a prompt. The agent will implement the issue, create a PR, and update the issue status.',
          parameters: {
            type: 'object',
            properties: {
              issueId: { type: 'string', description: 'Linear issue ID (e.g. "AGE-42")' },
              repo: { type: 'string', description: 'Git repo URL (e.g. "https://github.com/org/repo.git")' },
              profile: { type: 'string', description: 'Agent profile: coder, researcher, refiner, reviewer. Default: coder' },
            },
            required: ['issueId', 'repo'],
          },
        },
        implementation: async (args: { issueId: string; repo: string; profile?: string }) => {
          const issueId = args.issueId.toUpperCase();
          const branch = `${issueId}-remote`;

          const profile = args.profile ? AGENT_PROFILES[args.profile] : undefined;
          if (args.profile && !profile) {
            return { error: `Unknown profile "${args.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` };
          }

          await setupWorkspace(sandbox, env, { repo: args.repo, branch, setupLb: true });

          const issueResult = await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb show ${issueId} 2>&1`,
          );
          const issueDescription = issueResult.stdout || '';
          if (!issueDescription || issueDescription.includes('not found')) {
            return { error: `Issue ${issueId} not found`, raw: issueDescription };
          }

          await sandbox.exec(
            `cd ${WORK_DIR} && LINEAR_API_KEY=${env.LINEAR_API_KEY} lb update ${issueId} --status in_progress 2>&1 || true`,
          );

          const mergedMcp = { ...profile?.mcp };
          const { client } = await getClient(sandbox, env, mergedMcp);
          const session = await client.session.create({ title: `${issueId} — Remote Agent`, directory: WORK_DIR });
          if (!session.data) throw new Error(`Failed to create session: ${JSON.stringify(session)}`);

          const prompt = buildDispatchPrompt(issueId, branch, issueDescription, env);
          const model = profile?.model || DEFAULT_MODEL;
          const systemPrompt = profile?.system;
          const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

          await client.session.promptAsync({
            sessionID: session.data.id,
            directory: WORK_DIR,
            model,
            parts: [{ type: 'text', text: fullPrompt }],
          });

          // Start the container-side event forwarder (fire-and-forget)
          // It streams opencode SSE → POST /internal/append-event on the Worker
          sandbox.exec(
            `node /usr/local/bin/forwarder.js`,
            {
              env: {
                OPENCODE_PORT: '4096',
                WORKER_URL: env.WORKER_URL,
                SESSION_ID: session.data.id,
                SESSION_LABEL: String(issueId),
                INTERNAL_SECRET: env.INTERNAL_SECRET,
              },
            },
          ).catch((e: unknown) => console.error('[forwarder] exec error:', e));

          // Notify browser to start polling for events from this session
          this.broadcast(JSON.stringify({
            type: 'agent:session:started',
            sessionId: session.data.id,
            label: String(issueId),
          }));

          await (sandbox as unknown as Sandbox).logSession({
            sessionId: session.data.id,
            issueId,
            prompt: fullPrompt,
            model,
            repo: args.repo,
            branch,
            workspaceKey: `issue/${issueId}`,
          });

          return { sessionId: session.data.id, issueId, branch, status: 'dispatched', model };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'kickoff',
          description: 'Send a raw prompt to a remote agent. No lb integration — just a container with opencode. Optionally clone a repo (pass the URL from create_repo) or use a named workspace.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The prompt/instructions to send to the agent' },
              repo: { type: 'string', description: 'Git repo URL to clone — use the repoUrl returned by create_repo (optional)' },
              workspace: { type: 'string', description: 'Named workspace — persists across sessions via R2 (optional)' },
              branch: { type: 'string', description: 'Git branch to checkout (optional)' },
              profile: { type: 'string', description: 'Agent profile: coder, researcher, refiner, reviewer (optional)' },
            },
            required: ['text'],
          },
        },
        implementation: async (args: {
          text: string;
          repo?: string;
          workspace?: string;
          branch?: string;
          profile?: string;
        }) => {
          const profile = args.profile ? AGENT_PROFILES[args.profile] : undefined;
          if (args.profile && !profile) {
            return { error: `Unknown profile "${args.profile}". Available: ${Object.keys(AGENT_PROFILES).join(', ')}` };
          }

          const repoUrl = await setupWorkspace(sandbox, env, {
            repo: args.repo,
            branch: args.branch,
            workspace: args.workspace,
            setupLb: false,
          });

          const mergedMcp = { ...profile?.mcp };
          const { client } = await getClient(sandbox, env, mergedMcp);
          const session = await client.session.create({
            title: args.workspace ? `Workspace: ${args.workspace}` : args.repo ? `Repo: ${args.repo.split('/').pop()?.replace('.git', '')}` : 'Remote Agent',
            directory: WORK_DIR,
          });
          if (!session.data) throw new Error(`Failed to create session: ${JSON.stringify(session)}`);

          let promptText = args.text;
          if (repoUrl) {
            promptText += `\n\n## Persistence\n\nYour workspace is backed by a GitHub repo: ${repoUrl}\nWhen done, commit and push: \`git add -A && git commit -m "description" && git push\``;
          } else if (args.workspace) {
            promptText += `\n\n## Persistence\n\nYour workspace "${args.workspace}" persists via R2. No git push needed.`;
          }

          const systemPrompt = profile?.system;
          const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${promptText}` : promptText;
          const model = profile?.model || DEFAULT_MODEL;

          await client.session.promptAsync({
            sessionID: session.data.id,
            directory: WORK_DIR,
            model,
            parts: [{ type: 'text', text: fullPrompt }],
          });

          // Start the container-side event forwarder (fire-and-forget)
          const sessionLabel = args.workspace ?? args.repo ?? 'agent';
          sandbox.exec(
            `node /usr/local/bin/forwarder.js`,
            {
              env: {
                OPENCODE_PORT: '4096',
                WORKER_URL: env.WORKER_URL,
                SESSION_ID: session.data.id,
                SESSION_LABEL: sessionLabel,
                INTERNAL_SECRET: env.INTERNAL_SECRET,
              },
            },
          ).catch((e: unknown) => console.error('[forwarder] exec error:', e));

          // Notify browser to start polling for events from this session
          this.broadcast(JSON.stringify({
            type: 'agent:session:started',
            sessionId: session.data.id,
            label: sessionLabel,
          }));

          const workspaceKey = args.workspace ? `named/${args.workspace}` : undefined;
          await (sandbox as unknown as Sandbox).logSession({
            sessionId: session.data.id,
            prompt: fullPrompt,
            model,
            repo: repoUrl ?? undefined,
            workspaceKey,
          });

          return { sessionId: session.data.id, status: 'kicked off', model, repo: repoUrl, workspace: args.workspace ?? null };
        },
      },

      // =====================================================================
      // SESSION MANAGEMENT
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'check_session',
          description: 'Check the status of a running session. Returns whether the agent is busy or idle, and recent messages.',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID to check' },
            },
            required: ['sessionId'],
          },
        },
        implementation: async (args: { sessionId: string }) => {
          try {
            const { client } = await getClient(sandbox, env);
            const [session, status, messages] = await Promise.all([
              client.session.get({ sessionID: args.sessionId, directory: WORK_DIR }),
              client.session.status({ directory: WORK_DIR }),
              client.session.messages({ sessionID: args.sessionId, directory: WORK_DIR }),
            ]);

            const statusData = status.data ?? {};
            const sessionBusy = statusData[args.sessionId]?.type === 'busy';
            const liveMessages = messages.data ?? [];

            if (!sessionBusy && liveMessages.length > 0) {
              try {
                await (sandbox as unknown as Sandbox).saveMessages(args.sessionId, liveMessages);
                await (sandbox as unknown as Sandbox).updateSessionStatus(args.sessionId, 'completed');
              } catch { /* non-fatal */ }
            }

            const recentMessages = liveMessages.slice(-5).map((m: any) => ({
              role: m.role ?? m.type ?? 'unknown',
              content: typeof m.content === 'string' ? m.content?.slice(0, 500) :
                Array.isArray(m.parts) ? m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').slice(0, 500) : null,
            }));

            return {
              source: 'live',
              session: session.data ?? null,
              busy: sessionBusy,
              messageCount: liveMessages.length,
              recentMessages,
            };
          } catch {
            try {
              const log = await (sandbox as unknown as Sandbox).getSessionLog(args.sessionId);
              const saved = await (sandbox as unknown as Sandbox).getSessionMessages(args.sessionId);
              return { source: 'persisted', session: log, messageCount: saved.length, busy: false };
            } catch {
              return { error: `Session ${args.sessionId} not found (container unavailable)` };
            }
          }
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'send_message',
          description: 'Send a follow-up message to a running session. The agent will process it asynchronously.',
          parameters: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID to message' },
              text: { type: 'string', description: 'The message to send' },
            },
            required: ['sessionId', 'text'],
          },
        },
        implementation: async (args: { sessionId: string; text: string }) => {
          const { client } = await getClient(sandbox, env);
          await client.session.promptAsync({
            sessionID: args.sessionId,
            directory: WORK_DIR,
            model: DEFAULT_MODEL,
            parts: [{ type: 'text', text: args.text }],
          });
          return { status: 'sent', sessionId: args.sessionId };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'list_sessions',
          description: 'List all sessions — both persisted (from DO SQLite) and live (from container).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const persisted = await (sandbox as unknown as Sandbox).getSessions();

          let live: any[] = [];
          try {
            const { client } = await getClient(sandbox, env);
            const sessions = await client.session.list({ directory: WORK_DIR });
            live = sessions.data ?? [];
          } catch { /* container dead */ }

          return { persisted, live };
        },
      },

      // =====================================================================
      // CONTAINER OPERATIONS
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'exec_command',
          description: 'Execute a shell command in the container. Useful for debugging, checking git status, running tests, etc.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to run' },
            },
            required: ['command'],
          },
        },
        implementation: async (args: { command: string }) => {
          const result = await sandbox.exec(args.command);
          return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            exitCode: result.exitCode ?? 0,
          };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a file from the container workspace. Returns file content or directory listing.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace root (e.g. "src/index.ts")' },
            },
            required: ['path'],
          },
        },
        implementation: async (args: { path: string }) => {
          if (!args.path || args.path.includes('..')) {
            return { error: 'Invalid file path' };
          }
          const fullPath = `${WORK_DIR}/${args.path}`;
          const checkResult = await sandbox.exec(`test -d "${fullPath}" && echo DIR || test -f "${fullPath}" && echo FILE || echo NOTFOUND`);
          const type = checkResult.stdout?.trim();

          if (type === 'NOTFOUND') return { error: `File not found: ${args.path}` };
          if (type === 'DIR') {
            const ls = await sandbox.exec(`ls -la "${fullPath}"`);
            return { type: 'directory', path: args.path, listing: ls.stdout };
          }

          const result = await sandbox.readFile(fullPath);
          return { type: 'file', path: args.path, content: result.content };
        },
      },

      // =====================================================================
      // WORKSPACE MANAGEMENT
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'save_workspace',
          description: 'Save the current container workspace to R2 for persistence.',
          parameters: {
            type: 'object',
            properties: {
              workspace: { type: 'string', description: 'Named workspace key (e.g. "my-project")' },
              sessionId: { type: 'string', description: 'Session ID (alternative to workspace name)' },
              issueId: { type: 'string', description: 'Issue ID (alternative to workspace name)' },
            },
            required: [],
          },
        },
        implementation: async (args: { workspace?: string; sessionId?: string; issueId?: string }) => {
          const key = resolveWorkspaceKey(args);
          const result = await saveWorkspace(sandbox, env, key);
          return { saved: true, key: result.key, size: result.size, sizeHuman: `${(result.size / 1024 / 1024).toFixed(2)} MB` };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'list_workspaces',
          description: 'List all saved workspaces in R2.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
        implementation: async () => {
          const list = await env.R2_BUCKET.list({ prefix: 'workspaces/' });
          return list.objects.map((obj: any) => ({
            key: obj.key,
            name: obj.key.replace('workspaces/', '').replace('.tar.gz', ''),
            size: obj.size,
            sizeHuman: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
            uploaded: obj.uploaded.toISOString(),
          }));
        },
      },

      // =====================================================================
      // LINEAR API (direct — no container dependency)
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'linear_issues',
          description: 'List Linear issues. Filter by status (e.g. "todo_refined", "in_progress", "in_review") or state type (e.g. "unstarted", "started"). Defaults to all unstarted + started issues for team AGE.',
          parameters: {
            type: 'object',
            properties: {
              stateNames: { type: 'array', items: { type: 'string' }, description: 'Filter by exact state names, e.g. ["todo_refined", "in_progress"]' },
              stateTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by state type: "unstarted", "started", "completed", "cancelled"' },
              label: { type: 'string', description: 'Filter by label name' },
              limit: { type: 'number', description: 'Max issues to return (default 50)' },
            },
            required: [],
          },
        },
        implementation: async (args: { stateNames?: string[]; stateTypes?: string[]; label?: string; limit?: number }) => {
          const issues = await listIssues(env.LINEAR_API_KEY, {
            teamKey: 'AGE',
            stateNames: args.stateNames,
            stateTypes: args.stateTypes ?? (args.stateNames ? undefined : ['unstarted', 'started']),
            label: args.label,
            limit: args.limit,
          });
          return { count: issues.length, issues: formatIssueList(issues) };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'linear_show',
          description: 'Get full details of a Linear issue by identifier (e.g. "AGE-42"). Returns title, status, description, relations.',
          parameters: {
            type: 'object',
            properties: {
              issueId: { type: 'string', description: 'Issue identifier, e.g. "AGE-42"' },
            },
            required: ['issueId'],
          },
        },
        implementation: async (args: { issueId: string }) => {
          const issue = await getIssue(env.LINEAR_API_KEY, args.issueId.toUpperCase());
          return { detail: formatIssueDetail(issue), raw: { id: issue.id, identifier: issue.identifier } };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'linear_update_status',
          description: 'Update the status of a Linear issue. Common statuses: todo_needs_refinement, todo_refined, in_progress, in_review, done.',
          parameters: {
            type: 'object',
            properties: {
              issueId: { type: 'string', description: 'Issue identifier, e.g. "AGE-42"' },
              status: { type: 'string', description: 'New status name, e.g. "in_progress"' },
            },
            required: ['issueId', 'status'],
          },
        },
        implementation: async (args: { issueId: string; status: string }) => {
          const issue = await getIssue(env.LINEAR_API_KEY, args.issueId.toUpperCase());
          await updateIssueState(env.LINEAR_API_KEY, issue.id, args.status);
          return { updated: true, issueId: args.issueId, status: args.status };
        },
      },

      {
        type: 'function' as const,
        function: {
          name: 'linear_create',
          description: 'Create a new Linear issue in team AGE.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Issue title' },
              description: { type: 'string', description: 'Issue description (markdown)' },
              parentId: { type: 'string', description: 'Parent issue identifier (e.g. "AGE-10") to create as subtask' },
            },
            required: ['title'],
          },
        },
        implementation: async (args: { title: string; description?: string; parentId?: string }) => {
          let resolvedParentId: string | undefined;
          if (args.parentId) {
            const parent = await getIssue(env.LINEAR_API_KEY, args.parentId.toUpperCase());
            resolvedParentId = parent.id;
          }
          const created = await createIssue(env.LINEAR_API_KEY, {
            teamKey: 'AGE',
            title: args.title,
            description: args.description,
            parentId: resolvedParentId,
          });
          return { created: true, identifier: created.identifier, id: created.id };
        },
      },

      // =====================================================================
      // GITHUB REPO MANAGEMENT
      // =====================================================================
      {
        type: 'function' as const,
        function: {
          name: 'create_repo',
          description: 'Create a new private GitHub repository under the agentic-flows org. Returns the clone URL to pass to kickoff or dispatch_issue.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Repository name (e.g. "research-quantum-computing")' },
              description: { type: 'string', description: 'Repository description (optional)' },
            },
            required: ['name'],
          },
        },
        implementation: async (args: { name: string; description?: string }) => {
          // Auth gh first, then create the repo
          await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token 2>&1 || true`);
          const descFlag = args.description ? ` --description "${args.description.replace(/"/g, '')}"` : '';
          const result = await sandbox.exec(
            `gh repo create agentic-flows/${args.name} --private${descFlag} 2>&1`,
          );
          if (result.exitCode !== 0 && !result.stdout?.includes('already exists')) {
            return { error: `Failed to create repo: ${result.stdout || result.stderr}` };
          }
          const repoUrl = `https://github.com/agentic-flows/${args.name}.git`;
          return { repoUrl, name: args.name, org: 'agentic-flows' };
        },
      },

      // LB tools intentionally excluded — available in code but not exposed to LLM
    ];
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function buildDispatchPrompt(
  issueId: string,
  branch: string,
  issueDescription: string,
  _env: Env,
): string {
  return `You are a remote coding agent working on issue ${issueId}.
You are on branch \`${branch}\` in /home/user/workspace.

## Your Issue

${issueDescription}

## Instructions

1. Read the issue carefully. Implement what is described.
2. Make your changes in the workspace. Write clean, well-structured code.
3. Test your changes if there are tests available (check package.json scripts).
4. When you are done coding:
   a. Stage and commit your changes with a descriptive commit message referencing ${issueId}.
   b. Push the branch: \`git push -u origin ${branch}\`
   c. Create a PR: \`gh pr create --title "${issueId}: <short summary>" --body "<description of changes>" --base main\`
   d. Update the issue status: \`LINEAR_API_KEY=$LINEAR_API_KEY lb update ${issueId} --status in_review\`
5. If you discover bugs or issues while working, create them immediately:
   \`LINEAR_API_KEY=$LINEAR_API_KEY lb create "Found: <description>" --discovered-from ${issueId} -d "Details..."\`

## Environment

- Git is configured with author identity.
- GitHub CLI (\`gh\`) is authenticated — you can push and create PRs.
- \`lb\` is available for issue tracking. LINEAR_API_KEY is set in the environment.
- You are on branch \`${branch}\`, based off \`main\`.

## Important

- Do NOT ask for clarification. Work with what you have.
- Do NOT skip steps. Commit, push, create PR, and update the issue status.
- Be thorough. The issue description contains your acceptance criteria.
`;
}
