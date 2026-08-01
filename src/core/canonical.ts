import type { Block, CanonicalPrefix, Part } from '../types.js';
import { sha256 } from './hash.js';

/**
 * Canonical serialisation of a prefix into a comparable byte stream.
 *
 * Fields are length prefixed rather than delimited, so no content can forge a
 * field boundary by containing a separator. Every text and json payload
 * records its byte range, which is how a divergence offset in the stream maps
 * back to a block and a part without reconstructing anything afterwards.
 */

export interface OffsetEntry {
  blockIndex: number;
  partIndex: number;
  type: Part['type'];
  /** Full encoded extent of the part, including its tag and length prefix. */
  spanStart: number;
  spanEnd: number;
  /**
   * Extent of the content itself. Mapping a divergence offset to a position
   * inside a piece of text uses this, so the reported offset is an offset into
   * the user's content rather than into our framing.
   */
  payloadStart: number;
  payloadEnd: number;
}

export interface SerializedPrefix {
  bytes: Buffer;
  map: OffsetEntry[];
  /** Byte length contributed by each block, in block order. */
  blockBytes: number[];
  /** Cumulative hash after each block. Used for block level localisation. */
  chain: string[];
}

const TAG_BLOCK = 0x01;
const TAG_TEXT = 0x10;
const TAG_JSON = 0x11;
const TAG_BINARY = 0x12;

class ByteWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  byte(value: number): void {
    this.push(Buffer.from([value & 0xff]));
  }

  /** Unsigned LEB128. */
  varint(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`varint requires a non-negative integer, received ${value}`);
    }
    const out: number[] = [];
    let n = value;
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    this.push(Buffer.from(out));
  }

  /**
   * Length prefixed UTF-8. Returns the byte range of the payload only, so the
   * offset map points at content rather than at framing.
   */
  string(value: string): { start: number; end: number } {
    const buf = Buffer.from(value, 'utf8');
    this.varint(buf.length);
    const start = this.length;
    this.push(buf);
    return { start, end: this.length };
  }

  private push(buf: Buffer): void {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }
}

function writePart(w: ByteWriter, part: Part, blockIndex: number, partIndex: number, map: OffsetEntry[]): void {
  const spanStart = w.offset;
  switch (part.type) {
    case 'text': {
      w.byte(TAG_TEXT);
      const range = w.string(part.text);
      map.push({ blockIndex, partIndex, type: 'text', spanStart, spanEnd: w.offset, payloadStart: range.start, payloadEnd: range.end });
      return;
    }
    case 'json': {
      w.byte(TAG_JSON);
      const range = w.string(part.canonical);
      map.push({ blockIndex, partIndex, type: 'json', spanStart, spanEnd: w.offset, payloadStart: range.start, payloadEnd: range.end });
      return;
    }
    case 'binary': {
      // Binary content is never compared byte by byte. It is represented by its
      // digest so a change is detectable and reportable without dumping bytes.
      w.byte(TAG_BINARY);
      w.string(part.sha256);
      w.varint(part.byteLength);
      w.string(part.mime);
      map.push({ blockIndex, partIndex, type: 'binary', spanStart, spanEnd: w.offset, payloadStart: spanStart, payloadEnd: w.offset });
      return;
    }
  }
}

export function serializePrefix(blocks: CanonicalPrefix): SerializedPrefix {
  const map: OffsetEntry[] = [];
  const blockBytes: number[] = [];
  const chain: string[] = [];
  const buffers: Buffer[] = [];

  let previousChain = '';
  let base = 0;

  // Each block is serialised into its own writer so the running hash chain can
  // digest one block at a time. Offsets are rebased onto the whole stream after.
  for (const block of blocks) {
    const w = new ByteWriter();
    const blockMap: OffsetEntry[] = [];

    w.byte(TAG_BLOCK);
    w.string(block.kind);
    w.string(block.role ?? '');
    w.byte(block.cacheMarker ? 1 : 0);
    w.string(block.cacheMarker?.ttl ?? '');
    w.varint(block.parts.length);
    for (let partIndex = 0; partIndex < block.parts.length; partIndex += 1) {
      const part = block.parts[partIndex];
      if (part) writePart(w, part, block.index, partIndex, blockMap);
    }

    const bytes = w.concat();
    for (const entry of blockMap) {
      map.push({
        ...entry,
        spanStart: entry.spanStart + base,
        spanEnd: entry.spanEnd + base,
        payloadStart: entry.payloadStart + base,
        payloadEnd: entry.payloadEnd + base,
      });
    }
    buffers.push(bytes);
    blockBytes.push(bytes.length);
    base += bytes.length;

    previousChain = sha256(previousChain + ':' + sha256(bytes));
    chain.push(previousChain);
  }

  return { bytes: Buffer.concat(buffers, base), map, blockBytes, chain };
}

export function prefixHash(blocks: CanonicalPrefix): string {
  return sha256(serializePrefix(blocks).bytes);
}

/** Maps a byte offset in the serialised stream back to a block and part. */
export function locate(map: OffsetEntry[], byteOffset: number): OffsetEntry | null {
  for (const entry of map) {
    if (byteOffset >= entry.spanStart && byteOffset < entry.spanEnd) return entry;
  }
  return null;
}

/**
 * Cuts a prefix down to the content that precedes a byte offset.
 *
 * This is what turns a divergence offset into a measurable shared span. Parts
 * that end before the cut survive whole, the part straddling it is truncated,
 * and everything after is dropped. Binary parts are dropped rather than
 * truncated, because half an image is not a smaller image.
 */
export function truncatePrefix(blocks: CanonicalPrefix, serialised: SerializedPrefix, byteOffset: number): CanonicalPrefix {
  if (byteOffset <= 0) return [];

  const out: Block[] = [];
  let blockStart = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const blockLength = serialised.blockBytes[i] ?? 0;
    if (!block) break;
    const blockEnd = blockStart + blockLength;

    if (blockEnd <= byteOffset) {
      out.push(block);
      blockStart = blockEnd;
      continue;
    }

    // The block straddling the cut keeps whatever parts finish before it.
    const parts: Part[] = [];
    for (const entry of serialised.map) {
      if (entry.blockIndex !== block.index) continue;
      const part = block.parts[entry.partIndex];
      if (!part) continue;

      if (entry.spanEnd <= byteOffset) {
        parts.push(part);
        continue;
      }
      if (entry.payloadStart >= byteOffset || part.type === 'binary') break;

      const text = part.type === 'text' ? part.text : part.canonical;
      const truncated = truncateUtf8(text, byteOffset - entry.payloadStart);
      if (truncated.length > 0) {
        parts.push(part.type === 'text' ? { type: 'text', text: truncated } : { type: 'json', canonical: truncated });
      }
      break;
    }

    if (parts.length > 0) out.push({ ...block, parts });
    break;
  }

  return out;
}

/** Cuts a string to at most `bytes` utf-8 bytes without splitting a character. */
export function truncateUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (bytes >= buffer.length) return text;

  let end = bytes;
  // Step back off a continuation byte so a multibyte character is never halved.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Stable JSON with recursively sorted keys.
 *
 * Tool schemas are frequently assembled from unordered sources, so they are
 * canonicalised before hashing. The original serialisation is kept separately
 * when the caller needs to report on ordering that the provider may or may not
 * normalise away.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortValue(source[key]);
    }
    return out;
  }
  return value;
}

/** Total characters of comparable content in a block, for reporting. */
export function blockCharLength(block: Block): number {
  let total = 0;
  for (const part of block.parts) {
    if (part.type === 'text') total += part.text.length;
    else if (part.type === 'json') total += part.canonical.length;
  }
  return total;
}
