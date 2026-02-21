/**
 * Metrics collection for voice pipeline components.
 * 
 * Based on Pipecat's metrics pattern - simple start/stop timing
 * with structured logging.
 */

export interface TTFBMetrics {
  processor: string;
  model?: string;
  value: number; // seconds
}

export interface ProcessingMetrics {
  processor: string;
  model?: string;
  value: number; // seconds
}

export interface TTFAMetrics {
  type: 'greeting' | 'response';
  ttfa: number; // ms - time from request to first audio
  totalFromConnect?: number; // ms - for greeting, total time from WebSocket connect
}

export class PipelineMetrics {
  private processor: string;
  private model?: string;
  
  private ttfbStartTime = 0;
  private processingStartTime = 0;

  constructor(processor: string, model?: string) {
    this.processor = processor;
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  // --- TTFB (Time to First Byte) ---

  startTTFB(): void {
    this.ttfbStartTime = Date.now();
  }

  stopTTFB(): TTFBMetrics | null {
    if (this.ttfbStartTime === 0) return null;
    
    const value = (Date.now() - this.ttfbStartTime) / 1000;
    console.log(`[Metrics] ${this.processor} TTFB: ${(value * 1000).toFixed(0)}ms`);
    
    this.ttfbStartTime = 0;
    return { processor: this.processor, model: this.model, value };
  }

  // --- Processing Time ---

  startProcessing(): void {
    this.processingStartTime = Date.now();
  }

  stopProcessing(): ProcessingMetrics | null {
    if (this.processingStartTime === 0) return null;
    
    const value = (Date.now() - this.processingStartTime) / 1000;
    console.log(`[Metrics] ${this.processor} processing: ${(value * 1000).toFixed(0)}ms`);
    
    this.processingStartTime = 0;
    return { processor: this.processor, model: this.model, value };
  }
}

/**
 * Tracks Time to First Audio (TTFA) for TTS output.
 * Measures from request start to first audio chunk sent.
 */
export class TTSMetrics {
  private connectTime = 0;
  private requestStartTime = 0;
  private requestType: 'greeting' | 'response' = 'response';
  private firstAudioSent = false;

  /** Call when WebSocket connects */
  markConnect(): void {
    this.connectTime = Date.now();
  }

  /** Call when starting a greeting */
  startGreeting(): void {
    this.requestStartTime = Date.now();
    this.requestType = 'greeting';
    this.firstAudioSent = false;
  }

  /** Call when starting a response (after user speaks) */
  startResponse(): void {
    this.requestStartTime = Date.now();
    this.requestType = 'response';
    this.firstAudioSent = false;
  }

  /** Call when first audio chunk is sent - logs and returns metrics */
  markFirstAudio(): TTFAMetrics | null {
    if (this.firstAudioSent || this.requestStartTime === 0) return null;
    this.firstAudioSent = true;

    const ttfa = Date.now() - this.requestStartTime;
    const metrics: TTFAMetrics = { type: this.requestType, ttfa };

    if (this.requestType === 'greeting' && this.connectTime > 0) {
      metrics.totalFromConnect = Date.now() - this.connectTime;
      console.log(`[Metrics] TTS TTFA: ${ttfa}ms (greeting, ${metrics.totalFromConnect}ms from connect)`);
    } else {
      console.log(`[Metrics] TTS TTFA: ${ttfa}ms (${this.requestType})`);
    }

    return metrics;
  }

  /** Reset for next request */
  reset(): void {
    this.requestStartTime = 0;
    this.firstAudioSent = false;
  }
}
