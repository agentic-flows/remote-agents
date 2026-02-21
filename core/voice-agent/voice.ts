/**
 * VoiceAgent — Reusable base class for voice agents on Cloudflare Workers.
 *
 * This class is ONLY responsible for:
 *   - STT (Deepgram Flux) connection and audio processing
 *   - TTS (Cloudflare Aura) connection and audio output
 *   - Flux state machine (StartOfTurn, EagerEndOfTurn, TurnResumed, EndOfTurn)
 *   - LLM inference (generateResponse, warmupLLM)
 *   - Conversation history management
 *   - Echo cancellation state
 *   - Audio format utilities
 *   - Metrics
 *
 * It does NOT contain:
 *   - Twilio connection management (WebSocket, streamSid, callSid)
 *   - Call lifecycle hooks invocation (onCallStarted, onCallEnded)
 *   - Hangup logic (executeHangup, terminateCall)
 *   - Twilio mark events (sendMark, handleMark)
 *   - Any transport-specific code
 *
 * The app layer (e.g. MyPhoneAgent) owns the transport connection,
 * decides when to call these building blocks, and manages call lifecycle.
 */

import { Agent, type AgentContext } from 'agents';
import type { CoreEnv } from '../types';
import type { Message } from '../infer/inferutils/common';
import type { AnyToolDefinition } from '../infer/tools/types';

import { CloudflareFluxSTT, type FluxResponse } from '../infer/stt/cloudflare-flux';
import { CloudflareAuraTTS } from '../infer/tts/cloudflare-aura';
import { infer, AbortError } from '../infer/inferutils/core';
import type { AIModels } from '../infer/inferutils/config.types';
import { twilioMulawToPcm16k, uint8ArrayToBase64 } from '../utils/audio';
import { PipelineMetrics, TTSMetrics } from '../utils/metrics';

// =============================================================================
// TYPES
// =============================================================================

export interface VoiceAgentState {
  callSid: string | null;
  callerPhone: string | null;
}

/**
 * Callbacks the app must provide so the core can emit audio/events
 * without knowing about the transport (Twilio, browser, etc).
 */
export interface VoiceTransportCallbacks {
  /** Called for every TTS audio chunk. App sends it to the transport. */
  onAudioChunk: (chunk: Uint8Array) => void;

  /** Called when TTS finishes generating audio for a response (flushed). */
  onTTSFlushed: () => void;

  /** Called on Flux StartOfTurn (barge-in). App should clear transport audio buffer. */
  onBargeIn: () => void;
}

// =============================================================================
// VOICE AGENT BASE CLASS
// =============================================================================

export abstract class VoiceAgent<
  TEnv extends CoreEnv & Cloudflare.Env = CoreEnv & Cloudflare.Env,
  TState extends VoiceAgentState = VoiceAgentState,
> extends Agent<TEnv, TState> {
  static options = { hibernate: false };

  // --- Services ---
  protected stt: CloudflareFluxSTT | null = null;
  protected tts: CloudflareAuraTTS | null = null;

  // --- LLM Config ---
  protected modelName: AIModels = 'openai/gpt-4.1-nano';
  protected llmTemperature: number | undefined = undefined;
  protected llmMaxTokens: number | undefined = undefined;
  protected gatewayName: string = 'phone-agent';

  // --- STT Config ---
  protected sttLanguage: string | undefined = undefined;
  protected sttKeywords: string[] | undefined = undefined;

  // --- Speech / Interruption Config ---
  /** Seconds to wait after STT+TTS ready before speaking. Default 0.4s. */
  protected waitSecondsBeforeSpeaking: number = 0.4;
  /**
   * Number of words caller must say to trigger barge-in (EagerEndOfTurn sensitivity).
   * Fewer words = lower eager_eot_threshold = easier to interrupt. Default 2.
   */
  protected numWordsToInterrupt: number = 2;
  /**
   * Seconds caller must speak after barge-in before agent stops speaking.
   * Implemented as a delay before re-enabling STT audio. Default 0.2s.
   */
  protected interruptionVoiceSeconds: number = 0.2;
  /**
   * Seconds of silence after barge-in before agent resumes speaking. Default 1.0s.
   */
  protected backoffSecondsAfterInterruption: number = 1.0;

  // --- LLM Control ---
  // DO NOT MODIFY - follows Deepgram docs: .opencode/knowledge/flux/06-eager-eot.md
  private abortController: AbortController | null = null;
  private pendingLLMRequest: Promise<void> | null = null;

  // --- Conversation ---
  protected history: Message[] = [];
  protected callEnding = false;
  protected systemPrompt: string | null = null;

  // --- Gateway log IDs (for post-call cost tracking via binding) ---
  protected gatewayLogIds: string[] = [];

  // --- Transport callbacks ---
  private transportCallbacks: VoiceTransportCallbacks | null = null;

  // --- Call metadata for LLM requests (Gateway tagging) ---
  private callMetadata: { callSid: string; callerPhone: string } | null = null;

  // --- Metrics ---
  protected llmMetrics = new PipelineMetrics('LLM');
  protected ttsMetrics = new TTSMetrics();
  protected streamStartTime = 0;

  // --- LLM Warmup ---
  private llmWarmedUp = false;

  // --- Echo cancellation ---
  protected isSpeaking = false;

  // --- Barge-in tracking (for backoff enforcement) ---
  private lastBargeInAt = 0;

  constructor(ctx: AgentContext, env: TEnv) {
    super(ctx, env);
    this.modelName = (env.LLM_MODEL || 'openai/gpt-4.1-nano') as AIModels;
    this.gatewayName = env.AI_GATEWAY_NAME || 'phone-agent';
    this.llmMetrics.setModel(this.modelName);
    console.log(`LLM configured: ${this.modelName} via gateway ${this.gatewayName}`);
  }

  // ===========================================================================
  // ABSTRACT HOOKS — App must implement
  // ===========================================================================

  protected abstract getGreeting(): string;
  protected abstract getSystemPrompt(): string | null;

  // ===========================================================================
  // OPTIONAL HOOKS — App can override
  // ===========================================================================

  protected getTools(): AnyToolDefinition[] | undefined { return undefined; }

  /** TTS voice/speaker. Override to change voice (e.g., 'arcas' for male). */
  protected getTTSSpeaker(): string | undefined { return undefined; }

  /** Override to return a hardcoded first response (skips LLM for lower latency). */
  protected getFirstResponseOverride(): string | null { return null; }

  // ===========================================================================
  // BUILDING BLOCKS — App calls these from its transport handlers
  // ===========================================================================

  /**
   * Initialize STT and TTS services. Call from your onConnect handler.
   * Returns a promise that resolves when both are ready.
   *
   * @param callbacks - Transport callbacks for audio output and events
   * @param callSid - Optional call ID for LLM metadata
   */
  protected async initVoicePipeline(
    callbacks: VoiceTransportCallbacks,
    callSid?: string,
  ): Promise<void> {
    this.transportCallbacks = callbacks;
    this.ttsMetrics.markConnect();
    console.log('[Core] Initializing voice pipeline');

    // STT — Flux
    // Map numWordsToInterrupt → eager_eot_threshold: fewer words = lower threshold = easier barge-in.
    // Formula: 0.9 - numWords * 0.06, clamped to [0.3, 0.9]
    const rawEagerThreshold = 0.9 - this.numWordsToInterrupt * 0.06;
    const eagerEotThreshold = Math.max(0.3, Math.min(0.9, rawEagerThreshold));

    this.stt = new CloudflareFluxSTT(
      {
        aiBinding: this.env.AI,
        ...(this.sttLanguage && { language: this.sttLanguage }),
        ...(this.sttKeywords?.length && { keywords: this.sttKeywords }),
        eagerEotThreshold: Math.round(eagerEotThreshold * 100) / 100,
      },
      { onMessage: (response: FluxResponse) => this.handleFluxEvent(response) },
    );

    // TTS
    const speaker = this.getTTSSpeaker();
    this.tts = new CloudflareAuraTTS({
      aiBinding: this.env.AI,
      accountId: this.env.CF_ACCOUNT_ID,
      apiToken: this.env.CF_API_TOKEN,
      ...(speaker && { speaker }),
    });
    this.tts.on({
      onAudioChunk: (chunk: Uint8Array) => {
        this.ttsMetrics.markFirstAudio();
        this.transportCallbacks?.onAudioChunk(chunk);
      },
      onFlushed: () => {
        console.log('[TTS] Audio generation flushed');
        this.transportCallbacks?.onTTSFlushed();
      },
    });

    // Connect both in parallel
    const startTime = Date.now();
    await Promise.all([
      this.stt.connect().then(() => {
        console.log(`[Timing] STT connected: ${Date.now() - startTime}ms`);
      }),
      this.tts.preconnect().then(() => {
        console.log(`[Timing] TTS connected: ${Date.now() - startTime}ms`);
      }),
    ]);
    console.log(`[Timing] STT+TTS ready: ${Date.now() - startTime}ms`);
  }

  /**
   * Send raw PCM audio to STT for transcription.
   * The app calls this from its media handler after converting transport format.
   */
  protected sendAudioToSTT(pcm16kAudio: ArrayBuffer): void {
    if (this.stt?.isConnected() && !this.isSpeaking) {
      this.stt.sendAudio(pcm16kAudio);
    }
  }

  /**
   * Convert Twilio mulaw base64 payload to PCM 16kHz and send to STT.
   * Convenience method for Twilio-based apps.
   */
  protected sendTwilioAudioToSTT(mulawBase64Payload: string): void {
    if (this.stt?.isConnected() && !this.isSpeaking) {
      this.stt.sendAudio(twilioMulawToPcm16k(mulawBase64Payload));
    }
  }

  /**
   * Speak text via TTS. Streams text into the TTS buffer.
   */
  protected speakTTS(text: string): void {
    this.tts?.speak(text);
  }

  /**
   * Flush TTS buffer — signals end of a response, generates remaining audio.
   */
  protected flushTTS(): void {
    this.tts?.flush();
  }

  /**
   * Clear TTS playback — used for barge-in.
   */
  protected clearTTS(): void {
    this.tts?.clear();
  }

  /**
   * Play the greeting via TTS and add it to conversation history.
   * Call after initVoicePipeline resolves.
   * Applies waitSecondsBeforeSpeaking delay before starting TTS.
   */
  protected playGreeting(): void {
    const greeting = this.getGreeting();
    const delayMs = Math.round(this.waitSecondsBeforeSpeaking * 1000);
    console.log(`[Core] Playing greeting in ${delayMs}ms: "${greeting}"`);
    this.isSpeaking = true;

    const speak = () => {
      this.tts?.speak(greeting);
      this.tts?.flush();
    };

    if (delayMs > 0) {
      setTimeout(speak, delayMs);
    } else {
      speak();
    }

    this.history.push({ role: 'assistant', content: greeting });
  }

  /**
   * Warm up the LLM while a greeting plays.
   * Sends a minimal request to prime the connection and cache system prompt.
   * Does NOT pollute conversation history.
   */
  protected async warmupLLM(callSid?: string): Promise<void> {
    if (this.llmWarmedUp) return;

    const startTime = Date.now();
    const systemPrompt = this.getSystemPrompt();

    if (!systemPrompt) {
      console.log('[Warmup] No system prompt available, skipping');
      return;
    }

    try {
      const warmupMessages: Message[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'hi' },
      ];

      await infer({
        env: this.env,
        metadata: { agentId: callSid || 'warmup', userId: 'warmup' },
        actionKey: 'testModelConfig',
        messages: warmupMessages,
        modelName: this.modelName,
        gatewayName: this.gatewayName,
        maxTokens: 16,
      });

      this.llmWarmedUp = true;
      console.log(`[Warmup] LLM warmed up in ${Date.now() - startTime}ms`);
    } catch (e) {
      console.error('[Warmup] LLM warmup error:', e);
    }
  }

  /**
   * Set call metadata for LLM request tagging (AI Gateway logs).
   * Call this from your 'start' handler so Gateway can track per-call costs.
   */
  protected setCallMetadata(callSid: string, callerPhone: string): void {
    this.callMetadata = { callSid, callerPhone };
  }

  /**
   * Set echo cancellation state. App controls this for greeting playback, etc.
   */
  protected setIsSpeaking(speaking: boolean): void {
    this.isSpeaking = speaking;
    console.log(`[Echo] isSpeaking=${speaking}`);
  }

  /**
   * Convert Twilio mulaw base64 to PCM 16kHz ArrayBuffer.
   * Exposed as a utility for the app layer.
   */
  protected static convertTwilioAudio(mulawBase64: string): ArrayBuffer {
    return twilioMulawToPcm16k(mulawBase64);
  }

  /**
   * Convert Uint8Array to base64 string.
   * Exposed as a utility for the app layer (e.g., encoding TTS chunks).
   */
  protected static encodeBase64(data: Uint8Array): string {
    return uint8ArrayToBase64(data);
  }

  /**
   * Release STT and TTS resources. Call when the call is over.
   * Does NOT fire any lifecycle hooks — that's the app's job.
   */
  protected cleanupVoicePipeline(): void {
    this.stt?.close();
    this.tts?.close();
    this.stt = null;
    this.tts = null;
    this.transportCallbacks = null;
    console.log('[Core] Voice pipeline cleaned up');
  }

  // ===========================================================================
  // FLUX STATE MACHINE - DO NOT MODIFY
  // ===========================================================================
  // Follows Deepgram Flux docs: .opencode/knowledge/flux/06-eager-eot.md
  //
  // Pattern:
  //   EagerEndOfTurn → start LLM request (don't await)
  //   TurnResumed    → abort request
  //   EndOfTurn      → await result and send to TTS
  //
  // Only TurnResumed cancels. StartOfTurn does NOT cancel.
  // ===========================================================================

  private handleFluxEvent(response: FluxResponse): void {
    if (!response.event) return;

    const { event, transcript, turn_index } = response;

    switch (event) {
      case 'StartOfTurn':
        console.log(`[Flux] ${event} turn=${turn_index} "${transcript || ''}"`);
        // Barge-in: notify the app to clear transport buffer
        this.transportCallbacks?.onBargeIn();
        this.tts?.clear();
        // Record barge-in time to enforce backoff before next LLM response
        this.lastBargeInAt = Date.now();
        // DO NOT abort LLM here - per docs, only TurnResumed cancels
        break;

      case 'EagerEndOfTurn':
        console.log(`[Flux] ${event} turn=${turn_index} "${transcript || ''}"`);
        if (transcript?.trim()) {
          this.ttsMetrics.startResponse();
          this.pendingLLMRequest = this.generateResponse(transcript);
        }
        break;

      case 'TurnResumed':
        console.log(`[Flux] ${event} turn=${turn_index} "${transcript || ''}"`);
        this.abortController?.abort();
        this.abortController = null;
        this.pendingLLMRequest = null;
        break;

      case 'EndOfTurn':
        console.log(`[Flux] ${event} turn=${turn_index} "${transcript || ''}"`);
        if (transcript?.trim()) {
          this.finalizeResponse(transcript);
        }
        break;
    }
  }

  /**
   * Generate LLM response and send to TTS.
   * Called on EagerEndOfTurn (speculative) or EndOfTurn (final).
   */
  private async generateResponse(userText: string): Promise<void> {
    if (!userText.trim()) return;

    // Enforce backoff after barge-in: wait before responding so agent
    // doesn't immediately talk over the caller who just interrupted.
    if (this.lastBargeInAt > 0 && this.backoffSecondsAfterInterruption > 0) {
      const elapsed = Date.now() - this.lastBargeInAt;
      const backoffMs = Math.round(this.backoffSecondsAfterInterruption * 1000);
      const remaining = backoffMs - elapsed;
      if (remaining > 0) {
        console.log(`[Speech] Backoff: waiting ${remaining}ms after barge-in`);
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      this.lastBargeInAt = 0;
    }

    // Check for hardcoded first response
    const firstResponseOverride = this.getFirstResponseOverride();
    if (firstResponseOverride) {
      this.history.push(
        { role: 'user', content: userText.trim() },
        { role: 'assistant', content: firstResponseOverride },
      );
      this.isSpeaking = true;
      this.tts?.speak(firstResponseOverride);
      this.tts?.flush();
      return;
    }

    this.abortController = new AbortController();
    this.systemPrompt = this.getSystemPrompt();
    const tools = this.getTools();

    const messages: Message[] = [];
    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }
    messages.push(...this.history);
    messages.push({ role: 'user', content: userText.trim() });

    try {
      this.llmMetrics.startTTFB();
      this.llmMetrics.startProcessing();

      let fullText = '';
      let firstChunk = true;

      const result = await infer({
        env: this.env,
        metadata: { agentId: this.callMetadata?.callSid || 'call', userId: this.callMetadata?.callerPhone || 'caller' },
        actionKey: 'testModelConfig',
        messages,
        modelName: this.modelName,
        temperature: this.llmTemperature,
        maxTokens: this.llmMaxTokens,
        gatewayName: this.gatewayName,
        tools,
        abortSignal: this.abortController?.signal,
        stream: {
          chunk_size: 1,
          onChunk: (chunk: string) => {
            if (firstChunk) {
              this.llmMetrics.stopTTFB();
              this.isSpeaking = true;
              firstChunk = false;
            }
            fullText += chunk;
            if (chunk) this.tts?.speak(chunk);
          },
        },
      });

      this.llmMetrics.stopProcessing();

      // Collect gateway log ID for post-call cost tracking
      if (result.gatewayLogId) {
        this.gatewayLogIds.push(result.gatewayLogId);
      }

      // Update history
      this.history.push({ role: 'user', content: userText.trim() });
      if (result.toolCallContext?.messages) {
        for (const msg of result.toolCallContext.messages) {
          this.history.push(msg);
        }
      }
      if (result.string) {
        this.history.push({ role: 'assistant', content: result.string });
      }

      if (this.history.length > 30) {
        this.history = this.history.slice(-30);
      }

      // Flush once at the end to generate all audio
      if (fullText.trim()) {
        this.tts?.flush();
      }

    } catch (e: unknown) {
      if (e instanceof AbortError) {
        console.log('[LLM] Request aborted');
      } else {
        console.error('[LLM] Error:', e);
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Finalize response on EndOfTurn.
   * If we have a pending request from EagerEndOfTurn, await it.
   * Otherwise generate fresh.
   */
  private async finalizeResponse(userText: string): Promise<void> {
    if (this.pendingLLMRequest) {
      console.log(`[Flux] Awaiting pending LLM request`);
      await this.pendingLLMRequest;
      this.pendingLLMRequest = null;
    } else {
      console.log(`[Flux] No pending request, generating fresh`);
      this.ttsMetrics.startResponse();
      await this.generateResponse(userText);
    }
  }
}
