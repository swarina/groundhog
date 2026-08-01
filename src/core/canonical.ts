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
  /** Byte range of the part's content in the serialised stream, excluding framing. */
  start: number;
  end: number;
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
  switch (part.type) {
    case 'text': {
      w.byte(TAG_TEXT);
      const range = w.string(part.text);
      map.push({ blockIndex, partIndex, type: 'text', start: range.start, end: range.end });
      return;
    }
    case 'json': {
      w.byte(TAG_JSON);
      const range = w.string(part.canonical);
      map.push({ blockIndex, partIndex, type: 'json', start: range.start, end: range.end });
      return;
    }
    case 'binary': {
      // Binary content is never compared byte by byte. It is represented by its
      // digest so a change is detectable and reportable without dumping bytes.
      const start = w.offset;
      w.byte(TAG_BINARY);
      w.string(part.sha256);
      w.varint(part.byteLength);
      w.string(part.mime);
      map.push({ blockIndex, partIndex, type: 'binary', start, end: w.offset });
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
      map.push({ ...entry, start: entry.start + base, end: entry.end + base });
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
    if (byteOffset >= entry.start && byteOffset < entry.end) return entry;
  }
  return null;
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
