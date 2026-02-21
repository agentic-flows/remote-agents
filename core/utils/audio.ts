/**
 * Audio conversion utilities for Twilio mulaw <-> PCM
 */

// Mulaw decode table (pre-computed for performance)
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;
  MULAW_DECODE_TABLE[i] = sign ? -magnitude : magnitude;
}

/**
 * Decode mulaw audio to PCM 16-bit
 */
export function decodeMulaw(mulawData: Uint8Array): Int16Array {
  const pcm = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = MULAW_DECODE_TABLE[mulawData[i]];
  }
  return pcm;
}

/**
 * Resample 8kHz PCM to 16kHz (linear interpolation)
 */
export function resample8kTo16k(input: Int16Array): Int16Array {
  const output = new Int16Array(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    const curr = input[i];
    const next = i < input.length - 1 ? input[i + 1] : curr;
    output[i * 2] = curr;
    output[i * 2 + 1] = (curr + next) >> 1;
  }
  return output;
}

/**
 * Convert base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert Twilio mulaw base64 payload to PCM16k ArrayBuffer
 */
export function twilioMulawToPcm16k(base64Payload: string): ArrayBuffer {
  const mulaw = base64ToUint8Array(base64Payload);
  const pcm8k = decodeMulaw(mulaw);
  const pcm16k = resample8kTo16k(pcm8k);
  const buffer = new ArrayBuffer(pcm16k.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < pcm16k.length; i++) {
    view.setInt16(i * 2, pcm16k[i], true);
  }
  return buffer;
}
