/**
 * Minimal hand-rolled protobuf encoder/decoder for the SFU Packet message.
 * Replaces @protobuf-ts/runtime to avoid the dependency.
 *
 * Proto definition (proto3):
 *   message Packet {
 *     uint32 sequenceNumber = 1;
 *     uint32 timestamp = 2;
 *     bytes payload = 5;
 *   }
 *
 * Wire format reference:
 *   - Varint (wire type 0): field 1 (sequenceNumber), field 2 (timestamp)
 *   - Length-delimited (wire type 2): field 5 (payload)
 *   - Tag = (fieldNumber << 3) | wireType
 */

export interface SfuPacket {
  sequenceNumber: number;
  timestamp: number;
  payload: Uint8Array;
}

// Wire types
const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

// Pre-computed tags
const TAG_SEQUENCE_NUMBER = (1 << 3) | WIRE_VARINT;          // 0x08
const TAG_TIMESTAMP = (2 << 3) | WIRE_VARINT;                // 0x10
const TAG_PAYLOAD = (5 << 3) | WIRE_LENGTH_DELIMITED;        // 0x2a

// =============================================================================
// ENCODER
// =============================================================================

/**
 * Encode a uint32 as a varint into a buffer at the given offset.
 * Returns the new offset after writing.
 */
function writeVarint(buf: Uint8Array, offset: number, value: number): number {
  value = value >>> 0; // Ensure unsigned 32-bit
  while (value > 0x7f) {
    buf[offset++] = (value & 0x7f) | 0x80;
    value >>>= 7;
  }
  buf[offset++] = value;
  return offset;
}

/**
 * Calculate the byte length of a varint-encoded uint32.
 */
function varintSize(value: number): number {
  value = value >>> 0;
  if (value <= 0x7f) return 1;
  if (value <= 0x3fff) return 2;
  if (value <= 0x1fffff) return 3;
  if (value <= 0x0fffffff) return 4;
  return 5;
}

/**
 * Encode an SFU Packet to binary protobuf format.
 */
export function encodeSfuPacket(packet: SfuPacket): Uint8Array {
  // Calculate total size
  let size = 0;

  if (packet.sequenceNumber !== 0) {
    size += 1 + varintSize(packet.sequenceNumber); // tag + varint
  }
  if (packet.timestamp !== 0) {
    size += 1 + varintSize(packet.timestamp); // tag + varint
  }
  if (packet.payload.length > 0) {
    size += 1 + varintSize(packet.payload.length) + packet.payload.length; // tag + length varint + bytes
  }

  const buf = new Uint8Array(size);
  let offset = 0;

  // Field 1: sequenceNumber (uint32, varint)
  if (packet.sequenceNumber !== 0) {
    buf[offset++] = TAG_SEQUENCE_NUMBER;
    offset = writeVarint(buf, offset, packet.sequenceNumber);
  }

  // Field 2: timestamp (uint32, varint)
  if (packet.timestamp !== 0) {
    buf[offset++] = TAG_TIMESTAMP;
    offset = writeVarint(buf, offset, packet.timestamp);
  }

  // Field 5: payload (bytes, length-delimited)
  if (packet.payload.length > 0) {
    buf[offset++] = TAG_PAYLOAD;
    offset = writeVarint(buf, offset, packet.payload.length);
    buf.set(packet.payload, offset);
    // offset += packet.payload.length; // not needed, we're done
  }

  return buf;
}

// =============================================================================
// DECODER
// =============================================================================

/**
 * Read a varint from a buffer at the given offset.
 * Returns [value, newOffset].
 */
function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('Varint too long');
  }
  return [result >>> 0, offset]; // Ensure unsigned
}

/**
 * Decode an SFU Packet from binary protobuf format.
 */
export function decodeSfuPacket(data: Uint8Array): SfuPacket {
  const packet: SfuPacket = {
    sequenceNumber: 0,
    timestamp: 0,
    payload: new Uint8Array(0),
  };

  let offset = 0;
  while (offset < data.length) {
    const [tag, newOffset] = readVarint(data, offset);
    offset = newOffset;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    switch (fieldNumber) {
      case 1: // sequenceNumber
        if (wireType !== WIRE_VARINT) throw new Error(`Expected varint for field 1, got wire type ${wireType}`);
        {
          const [value, nextOffset] = readVarint(data, offset);
          packet.sequenceNumber = value;
          offset = nextOffset;
        }
        break;

      case 2: // timestamp
        if (wireType !== WIRE_VARINT) throw new Error(`Expected varint for field 2, got wire type ${wireType}`);
        {
          const [value, nextOffset] = readVarint(data, offset);
          packet.timestamp = value;
          offset = nextOffset;
        }
        break;

      case 5: // payload
        if (wireType !== WIRE_LENGTH_DELIMITED) throw new Error(`Expected length-delimited for field 5, got wire type ${wireType}`);
        {
          const [length, nextOffset] = readVarint(data, offset);
          packet.payload = data.slice(nextOffset, nextOffset + length);
          offset = nextOffset + length;
        }
        break;

      default:
        // Skip unknown fields
        if (wireType === WIRE_VARINT) {
          const [, nextOffset] = readVarint(data, offset);
          offset = nextOffset;
        } else if (wireType === WIRE_LENGTH_DELIMITED) {
          const [length, nextOffset] = readVarint(data, offset);
          offset = nextOffset + length;
        } else if (wireType === 5) {
          offset += 4; // 32-bit
        } else if (wireType === 1) {
          offset += 8; // 64-bit
        } else {
          throw new Error(`Unknown wire type ${wireType} for field ${fieldNumber}`);
        }
        break;
    }
  }

  return packet;
}
