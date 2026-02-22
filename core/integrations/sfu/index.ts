/**
 * Cloudflare Calls SFU integration module.
 *
 * Provides WebRTC voice transport via the Cloudflare Calls SFU:
 *   - SfuClient: API client for session/track/adapter management
 *   - Packet codec: Hand-rolled protobuf encoder/decoder (no runtime dependency)
 *   - Audio utils: Resampling between SFU (48kHz stereo) and STT/TTS formats
 */

export { SfuClient, buildWsCallbackUrl, encodePcmForSfu, extractPcmFromSfuPacket } from './sfu-client.js';
export type { SfuConfig } from './sfu-client.js';
export { encodeSfuPacket, decodeSfuPacket } from './sfu-packet.js';
export type { SfuPacket } from './sfu-packet.js';
export { toMono16kFromStereo48k, resample24kToStereo48k, stereoToMono, monoToStereo } from './sfu-audio.js';
