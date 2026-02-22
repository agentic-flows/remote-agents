/**
 * Audio processing utilities for SFU WebRTC transport.
 *
 * The SFU delivers 48kHz stereo PCM via WebRTC (Opus decoded by browser/SFU).
 * STT (Flux) expects 16kHz mono PCM.
 * TTS (Aura) outputs 24kHz mono PCM.
 *
 * This module handles the conversions:
 *   - STT path: 48kHz stereo → 16kHz mono (downsample + stereo-to-mono)
 *   - TTS path: 24kHz mono → 48kHz stereo (upsample + mono-to-stereo)
 *
 * Pure JS implementations — no WASM/Speex dependency.
 */

// =============================================================================
// STEREO ↔ MONO
// =============================================================================

/**
 * Convert interleaved stereo Int16 samples to mono by averaging L+R channels.
 */
export function stereoToMono(stereoBuffer: ArrayBuffer): ArrayBuffer {
  const stereo = new Int16Array(stereoBuffer);
  const monoLength = Math.floor(stereo.length / 2);
  const mono = new Int16Array(monoLength);
  for (let i = 0; i < monoLength; i++) {
    // Average left + right, clamped to int16 range
    mono[i] = ((stereo[i * 2] + stereo[i * 2 + 1]) / 2) | 0;
  }
  return mono.buffer as ArrayBuffer;
}

/**
 * Convert mono Int16 samples to interleaved stereo (duplicate L → L+R).
 */
export function monoToStereo(monoBuffer: ArrayBuffer): ArrayBuffer {
  const mono = new Int16Array(monoBuffer);
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i];
    stereo[i * 2 + 1] = mono[i];
  }
  return stereo.buffer as ArrayBuffer;
}

// =============================================================================
// RESAMPLING (linear interpolation)
// =============================================================================

/**
 * Resample Int16 PCM from one sample rate to another using linear interpolation.
 */
function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    // Copy to avoid aliasing
    const copy = new Int16Array(input.length);
    copy.set(input);
    return copy;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIndex - low;
    output[i] = ((input[low] * (1 - frac) + input[high] * frac) + 0.5) | 0;
  }

  return output;
}

// =============================================================================
// STT PATH: 48kHz stereo → 16kHz mono
// =============================================================================

/**
 * Convert 48kHz stereo PCM to 16kHz mono PCM for STT.
 * Pipeline: stereo→mono, then downsample 48k→16k.
 */
export function toMono16kFromStereo48k(input48kStereo: ArrayBuffer): ArrayBuffer {
  if (input48kStereo.byteLength === 0) return input48kStereo;

  // Ensure even byte length for int16 alignment
  let buf = input48kStereo;
  if (buf.byteLength % 2 !== 0) {
    buf = buf.slice(0, buf.byteLength - 1);
  }

  // Step 1: stereo → mono (still 48kHz)
  const mono48k = stereoToMono(buf);

  // Step 2: downsample 48kHz → 16kHz
  const mono48kSamples = new Int16Array(mono48k);
  const mono16kSamples = resampleLinear(mono48kSamples, 48000, 16000);

  return mono16kSamples.buffer as ArrayBuffer;
}

// =============================================================================
// TTS PATH: 24kHz mono → 48kHz stereo
// =============================================================================

/**
 * Convert 24kHz mono PCM to 48kHz stereo PCM for SFU output.
 * Pipeline: upsample 24k→48k, then mono→stereo.
 */
export function resample24kToStereo48k(input24kMono: ArrayBuffer): ArrayBuffer {
  if (input24kMono.byteLength === 0) return input24kMono;

  // Ensure even byte length for int16 alignment
  let buf = input24kMono;
  if (buf.byteLength % 2 !== 0) {
    buf = buf.slice(0, buf.byteLength - 1);
  }

  // Step 1: upsample 24kHz → 48kHz (still mono)
  const mono24kSamples = new Int16Array(buf);
  const mono48kSamples = resampleLinear(mono24kSamples, 24000, 48000);

  // Step 2: mono → stereo
  return monoToStereo(mono48kSamples.buffer as ArrayBuffer);
}
