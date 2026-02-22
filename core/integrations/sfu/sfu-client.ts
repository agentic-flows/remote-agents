/**
 * SFU (Selective Forwarding Unit) client for Cloudflare Calls.
 *
 * Handles session creation, track publishing/subscribing, and WebSocket adapter
 * lifecycle for the Cloudflare Calls SFU. This is a reusable module — not tied
 * to any specific DO or agent implementation.
 *
 * Ported from realtime-examples/ai-tts-stt/src/shared/sfu-utils.ts with:
 *   - Generic env config (no Env type dependency)
 *   - Hand-rolled protobuf (no @protobuf-ts/runtime)
 */

import { encodeSfuPacket, decodeSfuPacket, type SfuPacket } from './sfu-packet.js';

// =============================================================================
// TYPES
// =============================================================================

export interface SfuConfig {
  /** SFU API base URL, e.g. "https://rtc.live.cloudflare.com/v1" */
  sfuApiBase: string;
  /** SFU App ID from Cloudflare dashboard */
  appId: string;
  /** Bearer token for SFU API authentication */
  bearerToken: string;
}

// =============================================================================
// SFU CLIENT
// =============================================================================

/**
 * High-level SFU API client for Cloudflare Calls.
 * Encapsulates common operations: session management, track publish/subscribe,
 * and WebSocket adapter lifecycle.
 */
export class SfuClient {
  private config: SfuConfig;

  constructor(config: SfuConfig) {
    this.config = config;
  }

  private get base(): string {
    return `${this.config.sfuApiBase}/apps/${this.config.appId}`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.bearerToken}`,
      'Content-Type': 'application/json',
    };
  }

  // --- Sessions & Tracks ---

  async createSession(): Promise<{ sessionId: string }> {
    const res = await fetch(`${this.base}/sessions/new`, {
      method: 'POST',
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`SFU createSession failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const sessionId = json?.sessionId;
    if (!sessionId) throw new Error('SFU createSession: sessionId missing in response');
    return { sessionId };
  }

  /**
   * Add tracks to an existing session using autoDiscover from the provided SDP offer.
   * Returns the full JSON response and the first audio trackName (if present).
   */
  async addTracksAutoDiscover(
    sessionId: string,
    sessionDescription: any,
  ): Promise<{ json: any; audioTrackName?: string }> {
    const body = { autoDiscover: true, sessionDescription };
    const res = await fetch(`${this.base}/sessions/${sessionId}/tracks/new`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`SFU addTracksAutoDiscover failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    const audio = json?.tracks?.find((t: any) => t.kind === 'audio' || !t.kind);
    const audioTrackName = audio?.trackName || json?.tracks?.[0]?.trackName;
    return { json, audioTrackName };
  }

  /**
   * Renegotiate an existing SFU session after requiresImmediateRenegotiation.
   * Called when pullRemoteTrackToPlayer returns { requiresImmediateRenegotiation: true }
   * and the browser creates a new offer for the second SDP exchange.
   *
   * PUT /apps/{appId}/sessions/{sessionId}/renegotiate
   */
  async renegotiateSession(
    sessionId: string,
    sessionDescription: any,
  ): Promise<{ sessionDescription: RTCSessionDescriptionInit }> {
    const res = await fetch(`${this.base}/sessions/${sessionId}/renegotiate`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ sessionDescription }),
    });
    if (!res.ok) {
      throw new Error(`SFU renegotiateSession failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as any;
    if (!json?.sessionDescription?.sdp) {
      throw new Error(`SFU renegotiateSession: missing sessionDescription.sdp in response. Keys: ${Object.keys(json || {}).join(', ')}`);
    }
    if (!json.sessionDescription.type) json.sessionDescription.type = 'answer';
    return { sessionDescription: json.sessionDescription as RTCSessionDescriptionInit };
  }

  /**
   * Pull a remote track from a publisher session into a new player session.
   * Used for the browser to subscribe to TTS audio.
   */
  async pullRemoteTrackToPlayer(
    playerSessionId: string,
    publisherSessionId: string,
    trackName: string,
    sessionDescription: any,
  ): Promise<any> {
    const body = {
      sessionDescription,
      tracks: [{ location: 'remote', sessionId: publisherSessionId, trackName, kind: 'audio' }],
    };
    const res = await fetch(`${this.base}/sessions/${playerSessionId}/tracks/new`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`SFU pullRemoteTrackToPlayer failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  // --- WebSocket Adapters ---

  /**
   * DO pushes PCM into SFU as a local track via WebSocket adapter.
   * Used by TTS publish path: DO generates TTS audio → pushes to SFU → SFU sends to browser via WebRTC.
   */
  async pushTrackFromWebSocket(
    trackName: string,
    endpoint: string,
    opts?: { inputCodec?: 'pcm'; mode?: 'buffer' },
  ): Promise<{ sessionId: string; adapterId: string; json: any }> {
    const body = {
      tracks: [
        {
          location: 'local',
          trackName,
          endpoint,
          inputCodec: opts?.inputCodec ?? 'pcm',
          mode: opts?.mode ?? 'buffer',
        },
      ],
    };
    const res = await fetch(`${this.base}/adapters/websocket/new`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SFU pushTrackFromWebSocket failed: ${res.status} ${text}`);
    }
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {}
    const sessionId = json?.tracks?.[0]?.sessionId;
    const adapterId = json?.tracks?.[0]?.adapterId;
    if (!sessionId || !adapterId) throw new Error('SFU pushTrackFromWebSocket: sessionId/adapterId missing');
    return { sessionId, adapterId, json };
  }

  /**
   * SFU pulls a remote track and streams PCM to our DO via WebSocket adapter.
   * Used by STT path: browser mic → WebRTC → SFU → WebSocket adapter → DO receives PCM.
   */
  async pullTrackToWebSocket(
    sessionId: string,
    trackName: string,
    endpoint: string,
    opts?: { outputCodec?: 'pcm' },
  ): Promise<{ adapterId?: string; json: any }> {
    const body = {
      tracks: [
        {
          location: 'remote',
          sessionId,
          trackName,
          endpoint,
          outputCodec: opts?.outputCodec ?? 'pcm',
        },
      ],
    };
    const res = await fetch(`${this.base}/adapters/websocket/new`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`SFU pullTrackToWebSocket failed: ${res.status} ${text}`);
    }
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {}
    const adapterId = json?.tracks?.[0]?.adapterId as string | undefined;
    return { adapterId, json };
  }

  /**
   * Idempotent close for WebSocket adapters.
   * If SFU returns 503 adapter_not_found, treat as already-closed success.
   */
  async closeWebSocketAdapter(
    adapterId: string,
  ): Promise<{ ok: boolean; alreadyClosed: boolean; status: number; text: string }> {
    const body = { tracks: [{ adapterId }] };
    const res = await fetch(`${this.base}/adapters/websocket/close`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return { ok: true, alreadyClosed: false, status: res.status, text };
    let alreadyClosed = false;
    if (res.status === 503) {
      try {
        const j = JSON.parse(text);
        if (j?.tracks?.[0]?.errorCode === 'adapter_not_found') alreadyClosed = true;
      } catch {}
    }
    return { ok: alreadyClosed, alreadyClosed, status: res.status, text };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build a WebSocket callback URL from an HTTP request.
 * The SFU will connect to this URL to send/receive audio data.
 */
export function buildWsCallbackUrl(request: Request, path: string): string {
  const url = new URL(request.url);
  url.pathname = path;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Encode PCM audio payload for SFU transmission (wraps in protobuf Packet).
 */
export function encodePcmForSfu(payload: ArrayBuffer): ArrayBuffer {
  const packet: SfuPacket = {
    sequenceNumber: 0,
    timestamp: 0,
    payload: new Uint8Array(payload),
  };
  const bytes = encodeSfuPacket(packet);
  // Return a freshly allocated ArrayBuffer to avoid byteOffset issues
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer as ArrayBuffer;
}

/**
 * Extract PCM audio from an SFU packet with safety checks.
 * Returns null if the packet is empty or malformed.
 */
export function extractPcmFromSfuPacket(packetData: ArrayBuffer): ArrayBuffer | null {
  try {
    const packet = decodeSfuPacket(new Uint8Array(packetData));
    if (!packet.payload || packet.payload.length === 0) {
      return null;
    }

    let payloadView = packet.payload;

    // Ensure even byte length for 16-bit PCM alignment
    if (payloadView.byteLength % 2 !== 0) {
      console.warn(`Odd payload length (${payloadView.byteLength}) detected. Truncating last byte.`);
      payloadView = payloadView.subarray(0, payloadView.byteLength - 1);
    }

    // Copy into a new Uint8Array to guarantee a clean ArrayBuffer backing
    const safeCopy = new Uint8Array(payloadView);
    return safeCopy.buffer as ArrayBuffer;
  } catch (error) {
    console.error('Error decoding SFU packet:', error);
    return null;
  }
}
