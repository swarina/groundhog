import type { Block, BlockKind, CanonicalPrefix, Part } from '../types.js';

/**
 * Locating the first point at which two prefixes stop being the same, and
 * measuring how much they share.
 *
 * This walks the canonical structure rather than the serialised byte stream.
 * The stream is length prefixed, so two texts of different length differ in the
 * framing before their content does, and comparing raw bytes would report a
 * divergence in a length header rather than in the prompt. A provider does not
 * see our framing, it tokenises the rendered content, so a comparison meant to
 * predict cache behaviour has to compare content too.
 *
 * The serialised stream and its hash chain remain the right tool for the
 * separate question of whether two prefixes are byte identical, which is what
 * the partition uses to group runs.
 */

export interface Divergence {
  /** Content bytes shared before the divergence, across the whole prefix. */
  contentByteOffset: number;
  /** Leading blocks that match in full. */
  sharedBlocks: number;
  blockIndex: number;
  blockKind: BlockKind;
  role?: string;
  partIndex: number | null;
  partType: Part['type'] | null;
  /** Offset within the diverging part's content, or null for a structural change. */
  offsetInPart: number | null;
  /** True when one prefix ends where the other continues. */
  isTruncation: boolean;
  /** True when the difference is a block or part shape, not content. */
  isStructural: boolean;
}

function partContent(part: Part): string | null {
  if (part.type === 'text') return part.text;
  if (part.type === 'json') return part.canonical;
  return null;
}

function partByteLength(part: Part): number {
  if (part.type === 'binary') return 0;
  return Buffer.byteLength(partContent(part) as string, 'utf8');
}

/** First differing byte of two strings, or -1 when one is a prefix of the other. */
function firstDifferingByte(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const limit = Math.min(ba.length, bb.length);
  let i = 0;
  for (; i < limit; i += 1) {
    if (ba[i] !== bb[i]) return i;
  }
  return ba.length === bb.length ? -1 : limit;
}

function blockShapeDiffers(a: Block, b: Block): boolean {
  return a.kind !== b.kind || a.role !== b.role || a.parts.length !== b.parts.length;
}

/**
 * Where two prefixes first differ, or null when they are identical.
 *
 * `contentByteOffset` counts content bytes, which is the offset a reader can
 * map back to their own prompt, rather than an offset into our encoding.
 */
export function firstDivergence(left: CanonicalPrefix, right: CanonicalPrefix): Divergence | null {
  let contentOffset = 0;
  const limit = Math.min(left.length, right.length);

  for (let b = 0; b < limit; b += 1) {
    const la = left[b] as Block;
    const lb = right[b] as Block;

    if (blockShapeDiffers(la, lb)) {
      return {
        contentByteOffset: contentOffset,
        sharedBlocks: b,
        blockIndex: la.index,
        blockKind: la.kind,
        ...(la.role ? { role: la.role } : {}),
        partIndex: null,
        partType: null,
        offsetInPart: null,
        isTruncation: false,
        isStructural: true,
      };
    }

    for (let p = 0; p < la.parts.length; p += 1) {
      const pa = la.parts[p] as Part;
      const pb = lb.parts[p] as Part;

      if (pa.type !== pb.type) {
        return structural(contentOffset, b, la, p, pa);
      }

      if (pa.type === 'binary' && pb.type === 'binary') {
        if (pa.sha256 !== pb.sha256) {
          return {
            contentByteOffset: contentOffset,
            sharedBlocks: b,
            blockIndex: la.index,
            blockKind: la.kind,
            ...(la.role ? { role: la.role } : {}),
            partIndex: p,
            partType: 'binary',
            offsetInPart: null,
            isTruncation: false,
            isStructural: false,
          };
        }
        continue;
      }

      const ca = partContent(pa) as string;
      const cb = partContent(pb) as string;
      const at = firstDifferingByte(ca, cb);
      if (at >= 0) {
        return {
          contentByteOffset: contentOffset + at,
          sharedBlocks: b,
          blockIndex: la.index,
          blockKind: la.kind,
          ...(la.role ? { role: la.role } : {}),
          partIndex: p,
          partType: pa.type,
          offsetInPart: at,
          isTruncation: at >= Math.min(Buffer.byteLength(ca, 'utf8'), Buffer.byteLength(cb, 'utf8')),
          isStructural: false,
        };
      }
      contentOffset += partByteLength(pa);
    }
  }

  if (left.length === right.length) return null;

  // One prefix is a structural prefix of the other: same blocks as far as the
  // shorter goes, then more blocks on one side.
  const shorter = left.length < right.length ? left : right;
  const nextBlock = (left.length < right.length ? right : left)[shorter.length] as Block;
  return {
    contentByteOffset: contentOffset,
    sharedBlocks: shorter.length,
    blockIndex: nextBlock.index,
    blockKind: nextBlock.kind,
    ...(nextBlock.role ? { role: nextBlock.role } : {}),
    partIndex: null,
    partType: null,
    offsetInPart: null,
    isTruncation: true,
    isStructural: true,
  };
}

function structural(contentOffset: number, blockPos: number, block: Block, partIndex: number, part: Part): Divergence {
  return {
    contentByteOffset: contentOffset,
    sharedBlocks: blockPos,
    blockIndex: block.index,
    blockKind: block.kind,
    ...(block.role ? { role: block.role } : {}),
    partIndex,
    partType: part.type,
    offsetInPart: null,
    isTruncation: false,
    isStructural: true,
  };
}

export interface SharedPrefix {
  /** Blocks every prefix shares in full. */
  blocks: number;
  /** Content bytes every prefix shares, including a partial block. */
  contentBytes: number;
  /** The shared content itself, so it can be measured in tokens. */
  prefix: CanonicalPrefix;
  /** True when every prefix compared was identical. */
  complete: boolean;
}

/** Cuts a string to at most `bytes` utf-8 bytes without splitting a character. */
export function truncateUtf8(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (bytes >= buffer.length) return text;
  let end = bytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * The longest content prefix every one of these shares.
 *
 * A provider matches on the longest prefix a request has in common with an
 * earlier one, so what an application repeats across its whole traffic is what
 * gets cached, not what any single request happens to contain. The result is
 * returned as content so it can be counted in tokens.
 */
export function sharedPrefix(prefixes: CanonicalPrefix[]): SharedPrefix {
  const first = prefixes[0];
  if (!first || prefixes.length === 0) return { blocks: 0, contentBytes: 0, prefix: [], complete: true };
  if (prefixes.length === 1) {
    return { blocks: first.length, contentBytes: totalContentBytes(first), prefix: first, complete: true };
  }

  let bound: Divergence | null = null;
  for (let i = 1; i < prefixes.length; i += 1) {
    const divergence = firstDivergence(first, prefixes[i] as CanonicalPrefix);
    if (!divergence) continue;
    if (bound === null || divergence.contentByteOffset < bound.contentByteOffset) bound = divergence;
  }

  if (bound === null) {
    return { blocks: first.length, contentBytes: totalContentBytes(first), prefix: first, complete: true };
  }

  return {
    blocks: bound.sharedBlocks,
    contentBytes: bound.contentByteOffset,
    prefix: buildSharedPrefix(first, bound),
    complete: false,
  };
}

function totalContentBytes(prefix: CanonicalPrefix): number {
  let total = 0;
  for (const block of prefix) for (const part of block.parts) total += partByteLength(part);
  return total;
}

/** The content up to the divergence, as blocks, with the last text part cut. */
function buildSharedPrefix(prefix: CanonicalPrefix, bound: Divergence): CanonicalPrefix {
  const out: Block[] = [];

  for (let b = 0; b < bound.sharedBlocks; b += 1) out.push(prefix[b] as Block);

  if (bound.partIndex != null && bound.offsetInPart != null && bound.offsetInPart > 0) {
    const block = prefix[bound.sharedBlocks] as Block;
    const parts: Part[] = block.parts.slice(0, bound.partIndex);
    const divergingPart = block.parts[bound.partIndex] as Part;
    const content = partContent(divergingPart);
    if (content != null) {
      const kept = truncateUtf8(content, bound.offsetInPart);
      if (kept.length > 0) {
        parts.push(divergingPart.type === 'text' ? { type: 'text', text: kept } : { type: 'json', canonical: kept });
      }
    }
    if (parts.length > 0) out.push({ ...block, parts });
  } else if (bound.partIndex != null && bound.partIndex > 0) {
    // A whole part diverged, but earlier parts of its block are shared.
    const block = prefix[bound.sharedBlocks] as Block;
    out.push({ ...block, parts: block.parts.slice(0, bound.partIndex) });
  }

  return out;
}
