/**
 * Cloudflare Deepgram Aura TTS Service
 *
 * Event-driven WebSocket TTS. speak() fires Speak+Flush and returns immediately.
 * Audio chunks and completion arrive via persistent event handlers — no blocking promises.
 */

import { dedupedConnect } from '../../utils/websocket';

export interface TTSConfig {
  /** Cloudflare Workers AI binding (env.AI) - preferred for lower latency */
  aiBinding?: Ai;
  /** Fallback: account ID for HTTP API */
  accountId?: string;
  /** Fallback: API token for HTTP API */
  apiToken?: string;
  encoding?: string;
  sampleRate?: string;
  speaker?: string;
}

export interface TTSEventCallbacks {
  onAudioChunk: (chunk: Uint8Array) => void;
  onFlushed: () => void;
}

export class CloudflareAuraTTS {
  private websocket: WebSocket | null = null;
  private connectionPromise: Promise<WebSocket> | null = null;
  private config: TTSConfig;
  private callbacks: TTSEventCallbacks | null = null;
  private active = false;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  /** Register persistent event callbacks. Call once before speak(). */
  on(callbacks: TTSEventCallbacks): void {
    this.callbacks = callbacks;
  }

  private async getOrCreateConnection(): Promise<WebSocket> {
    return await dedupedConnect({
      getCurrent: () => this.websocket,
      setCurrent: (ws) => { this.websocket = ws; },
      getCurrentPromise: () => this.connectionPromise,
      setCurrentPromise: (promise) => { this.connectionPromise = promise; },
      connectFn: () => this.connect(),
    });
  }

  async preconnect(): Promise<void> {
    await this.getOrCreateConnection();
  }

  private async connect(): Promise<WebSocket> {
    console.log('TTS connecting...');

    let ws: WebSocket | null = null;

    // Try binding first (faster - no network hop)
    if (this.config.aiBinding) {
      try {
        console.log('TTS: trying env.AI.run() binding...');
        const resp = await this.config.aiBinding.run("@cf/deepgram/aura-2-en" as Parameters<Ai['run']>[0], {
          encoding: this.config.encoding || 'mulaw',
          sample_rate: this.config.sampleRate || '8000',
          speaker: this.config.speaker || 'asteria',
          container: 'none',
        } as Parameters<Ai['run']>[1], {
          websocket: true
        });

        ws = (resp as unknown as { webSocket: WebSocket }).webSocket;
        if (ws) {
          console.log('TTS: binding worked!');
        }
      } catch (e) {
        console.warn('TTS: binding failed, falling back to HTTP:', e);
      }
    }

    // Fallback to HTTP fetch if binding didn't work
    if (!ws && this.config.accountId && this.config.apiToken) {
      console.log('TTS: using HTTP fetch fallback...');
      const params = new URLSearchParams({
        encoding: this.config.encoding || 'mulaw',
        sample_rate: this.config.sampleRate || '8000',
        speaker: this.config.speaker || 'asteria',
        container: 'none',
      });

      const url = `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/run/@cf/deepgram/aura-2-en?${params.toString()}`;

      const resp = await fetch(url, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
      });

      ws = resp.webSocket;
    }

    if (!ws) {
      throw new Error('TTS: Failed to establish WebSocket connection via binding or HTTP');
    }

    ws.accept();
    console.log('TTS WebSocket connected');

    // Persistent message handler — routes audio and control messages
    ws.addEventListener('message', (event: MessageEvent) => {
      if (!this.active || !this.callbacks) return;
      const data = event.data;

      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'Flushed') {
            this.callbacks.onFlushed();
          }
        } catch (e) {
          console.warn('Invalid JSON from TTS:', data);
        }
        return;
      }

      this.callbacks.onAudioChunk(new Uint8Array(data as ArrayBuffer));
    });

    ws.addEventListener('close', (event) => {
      console.log(`TTS WebSocket closed: ${event.code}`);
      if (this.websocket === ws) this.websocket = null;
    });

    ws.addEventListener('error', (event) => {
      console.error('TTS WebSocket error:', event);
      if (this.websocket === ws) this.websocket = null;
    });

    return ws;
  }

  /**
   * Send text for synthesis WITHOUT flushing. Call flush() when done.
   * This allows streaming LLM tokens directly to TTS.
   * Audio chunks arrive via onAudioChunk.
   */
  speak(text: string): void {
    this.active = true;
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: 'Speak', text }));
      return;
    }
    // Connection not ready — connect then send
    this.getOrCreateConnection().then((ws) => {
      if (!this.active) return;
      ws.send(JSON.stringify({ type: 'Speak', text }));
    }).catch((e) => {
      console.error('TTS speak connection error:', e);
    });
  }

  /**
   * Flush buffered text to generate audio. Call after all speak() calls.
   * Completion arrives via onFlushed callback.
   */
  flush(): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: 'Flush' }));
      return;
    }
    // Connection not ready — connect then flush
    this.getOrCreateConnection().then((ws) => {
      if (!this.active) return;
      ws.send(JSON.stringify({ type: 'Flush' }));
    }).catch((e) => {
      console.error('TTS flush connection error:', e);
    });
  }

  /**
   * Send Clear to stop current generation. Silences output immediately.
   * Keeps connection open for reuse.
   */
  clear(): void {
    this.active = false;
    if (this.websocket?.readyState === WebSocket.OPEN) {
      try {
        this.websocket.send(JSON.stringify({ type: 'Clear' }));
      } catch (e) {
        console.warn('TTS Clear failed, connection may be broken');
      }
    }
  }

  close(): void {
    this.active = false;
    if (this.websocket) {
      try {
        this.websocket.close();
      } catch {}
      this.websocket = null;
    }
    this.connectionPromise = null;
  }
}
