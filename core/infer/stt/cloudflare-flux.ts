/**
 * Cloudflare Deepgram Flux STT Service
 *
 * Uses env.AI.run() with { websocket: true } per Cloudflare docs:
 * https://developers.cloudflare.com/workers-ai/models/flux/
 *
 * Flux events: StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn
 */

// =============================================================================
// TYPES
// =============================================================================

export type FluxEventType =
  | 'Update'
  | 'StartOfTurn'
  | 'EagerEndOfTurn'
  | 'TurnResumed'
  | 'EndOfTurn';

export interface FluxWord {
  word: string;
  confidence: number;
}

export interface FluxResponse {
  request_id: string;
  sequence_id: number;
  event: FluxEventType;
  turn_index: number;
  audio_window_start: number;
  audio_window_end: number;
  transcript: string;
  words: FluxWord[];
  end_of_turn_confidence: number;
}

export interface FluxConfig {
  /** Cloudflare Workers AI binding (env.AI) */
  aiBinding: Ai;
  /** EOT timeout in ms (500-10000, default 5000). Forces EndOfTurn after silence. */
  eotTimeoutMs?: number;
  /** BCP-47 language code for transcription (e.g. 'en', 'es', 'fr'). Defaults to 'en'. */
  language?: string;
  /** Domain-specific keywords to boost recognition accuracy (e.g. brand names, product names). */
  keywords?: string[];
  /**
   * EagerEndOfTurn threshold (0.3–0.9, default 0.5).
   * Lower = triggers EOT sooner (fewer words needed to interrupt).
   * Higher = waits for more speech before triggering EOT (harder to interrupt).
   * Maps to num_words_to_interrupt config: fewer words → lower threshold.
   */
  eagerEotThreshold?: number;
  /**
   * EndOfTurn threshold (0.5–0.9, default 0.7).
   * Controls confidence required before finalising the turn.
   */
  eotThreshold?: number;
}

export interface FluxEventCallbacks {
  onMessage: (response: FluxResponse) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

// =============================================================================
// CLOUDFLARE FLUX STT
// =============================================================================

export class CloudflareFluxSTT {
  private websocket: WebSocket | null = null;
  private config: FluxConfig;
  private callbacks: FluxEventCallbacks;

  constructor(config: FluxConfig, callbacks: FluxEventCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    console.log('STT connecting to Flux...');

    const eagerEotThreshold = this.config.eagerEotThreshold ?? 0.5;
    const eotThreshold = this.config.eotThreshold ?? 0.7;

    const resp = await this.config.aiBinding.run("@cf/deepgram/flux" as Parameters<Ai['run']>[0], {
      encoding: "linear16",
      sample_rate: "16000",
      eager_eot_threshold: String(eagerEotThreshold),
      eot_threshold: String(eotThreshold),
      ...(this.config.eotTimeoutMs && { eot_timeout_ms: String(this.config.eotTimeoutMs) }),
      ...(this.config.language && { language: this.config.language }),
      ...(this.config.keywords?.length && { keywords: this.config.keywords.join(',') }),
    } as Parameters<Ai['run']>[1], {
      websocket: true
    });

    console.log('STT Flux resp:', resp);

    const ws = (resp as unknown as { webSocket: WebSocket }).webSocket;
    if (!ws) {
      throw new Error('Failed to establish Flux WebSocket');
    }

    ws.accept();
    this.websocket = ws;
    console.log('STT Flux connected');

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const response = JSON.parse(event.data) as FluxResponse;
        this.callbacks.onMessage(response);
      } catch (e) {
        console.error('STT Flux parse error:', e);
      }
    });

    ws.addEventListener('close', () => {
      console.log('STT Flux WebSocket closed');
      this.websocket = null;
      this.callbacks.onClose?.();
    });

    ws.addEventListener('error', (event) => {
      console.error('STT Flux WebSocket error:', event);
      this.callbacks.onError?.(new Error('STT Flux WebSocket failed'));
      this.close();
    });
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(buffer);
    }
  }

  isConnected(): boolean {
    return this.websocket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    if (this.websocket) {
      // Send CloseStream control message per Flux docs for graceful shutdown
      if (this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      try { this.websocket.close(); } catch {}
      this.websocket = null;
    }
  }
}
