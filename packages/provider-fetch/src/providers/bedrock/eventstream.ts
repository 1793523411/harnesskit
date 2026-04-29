// AWS Event Stream binary framing parser.
//
// Frame layout (big-endian everywhere):
//   [total_length      : u32]   total bytes including these 4
//   [headers_length    : u32]
//   [prelude_crc       : u32]   CRC32 of total_length + headers_length
//   [headers           : <headers_length bytes>]
//   [payload           : <total - headers - 16 bytes>]
//   [message_crc       : u32]   CRC32 of everything preceding it
//
// Header layout inside the headers section:
//   [name_len          : u8]
//   [name              : <name_len bytes ASCII>]
//   [value_type        : u8]   7 = string (the only one we need for Bedrock)
//   [value_len         : u16]  present for byte_array/string/etc.
//   [value             : <value_len bytes>]
//
// CRC validation is intentionally best-effort — we don't reject mismatched
// frames, we just don't care. Treat the parser as a framer, not a validator.

const HEADER_VALUE_STRING = 7;
const HEADER_VALUE_BYTE_ARRAY = 6;
const HEADER_VALUE_BOOLEAN_TRUE = 0;
const HEADER_VALUE_BOOLEAN_FALSE = 1;
const HEADER_VALUE_BYTE = 2;
const HEADER_VALUE_INT16 = 3;
const HEADER_VALUE_INT32 = 4;
const HEADER_VALUE_INT64 = 5;
const HEADER_VALUE_TIMESTAMP = 8;
const HEADER_VALUE_UUID = 9;

const HEADER_VALUE_FIXED_LEN: Record<number, number> = {
  [HEADER_VALUE_BYTE]: 1,
  [HEADER_VALUE_INT16]: 2,
  [HEADER_VALUE_INT32]: 4,
  [HEADER_VALUE_INT64]: 8,
  [HEADER_VALUE_TIMESTAMP]: 8,
  [HEADER_VALUE_UUID]: 16,
};

export interface EventStreamFrame {
  headers: Map<string, string>;
  payload: Uint8Array;
}

const decoder = new TextDecoder();

const parseHeaders = (bytes: Uint8Array): Map<string, string> => {
  const out = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const nameLen = view.getUint8(cursor);
    cursor += 1;
    const name = decoder.decode(bytes.subarray(cursor, cursor + nameLen));
    cursor += nameLen;
    const valueType = view.getUint8(cursor);
    cursor += 1;
    if (valueType === HEADER_VALUE_STRING || valueType === HEADER_VALUE_BYTE_ARRAY) {
      const valueLen = view.getUint16(cursor, false);
      cursor += 2;
      const value = decoder.decode(bytes.subarray(cursor, cursor + valueLen));
      cursor += valueLen;
      out.set(name, value);
    } else if (
      valueType === HEADER_VALUE_BOOLEAN_TRUE ||
      valueType === HEADER_VALUE_BOOLEAN_FALSE
    ) {
      out.set(name, valueType === HEADER_VALUE_BOOLEAN_TRUE ? 'true' : 'false');
    } else {
      const fixedLen = HEADER_VALUE_FIXED_LEN[valueType];
      if (fixedLen === undefined) {
        // Unknown type — abort header parsing for this frame; we already have
        // the keys we care about (`:event-type`, `:content-type`).
        break;
      }
      cursor += fixedLen;
    }
  }
  return out;
};

/**
 * Reads the stream and yields complete frames. Buffers partial frames across
 * chunk boundaries. Drops bytes only when a frame's total_length declares a
 * length that overshoots the remaining buffer — in which case we wait for
 * more input.
 */
export async function* readEventStreamFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamFrame, void, void> {
  const reader = stream.getReader();
  let buf = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      while (buf.length >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const totalLen = view.getUint32(0, false);
        if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
          // Garbage frame length — skip the rest. 16MB is the AWS hard cap.
          buf = new Uint8Array(0);
          break;
        }
        if (buf.length < totalLen) break;
        const headersLen = view.getUint32(4, false);
        const headerStart = 12;
        const headerEnd = headerStart + headersLen;
        const payloadEnd = totalLen - 4;
        if (headerEnd > payloadEnd || payloadEnd > buf.length) {
          // Inconsistent frame — bail.
          buf = new Uint8Array(0);
          break;
        }
        const headers = parseHeaders(buf.subarray(headerStart, headerEnd));
        const payload = buf.slice(headerEnd, payloadEnd);
        yield { headers, payload };
        buf = buf.slice(totalLen);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Test helper — encodes a frame in AWS Event Stream layout. CRC fields are
 * filled with zeros (the parser doesn't validate them).
 */
export const encodeFrameForTest = (
  headers: Record<string, string>,
  payload: Uint8Array,
): Uint8Array => {
  const enc = new TextEncoder();
  // Encode headers
  const headerChunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(buf.buffer);
    let cursor = 0;
    view.setUint8(cursor, nameBytes.length);
    cursor += 1;
    buf.set(nameBytes, cursor);
    cursor += nameBytes.length;
    view.setUint8(cursor, HEADER_VALUE_STRING);
    cursor += 1;
    view.setUint16(cursor, valueBytes.length, false);
    cursor += 2;
    buf.set(valueBytes, cursor);
    headerChunks.push(buf);
  }
  let headerBytesLen = 0;
  for (const c of headerChunks) headerBytesLen += c.length;
  const headerBytes = new Uint8Array(headerBytesLen);
  let off = 0;
  for (const c of headerChunks) {
    headerBytes.set(c, off);
    off += c.length;
  }
  const totalLen = 4 + 4 + 4 + headerBytes.length + payload.length + 4;
  const frame = new Uint8Array(totalLen);
  const fview = new DataView(frame.buffer);
  let p = 0;
  fview.setUint32(p, totalLen, false);
  p += 4;
  fview.setUint32(p, headerBytes.length, false);
  p += 4;
  fview.setUint32(p, 0, false); // prelude CRC, ignored
  p += 4;
  frame.set(headerBytes, p);
  p += headerBytes.length;
  frame.set(payload, p);
  p += payload.length;
  fview.setUint32(p, 0, false); // message CRC, ignored
  return frame;
};
