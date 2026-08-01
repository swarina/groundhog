import type { BlockKind, CanonicalPrefix, Part } from '../types.js';
import { locate, serializePrefix, truncatePrefix, type OffsetEntry, type SerializedPrefix } from './canonical.js';

/**
 * Locating the first byte at which two prefixes stop being the same.
 *
 * The block hash chain narrows to the first block that differs without touching
 * any content. A byte scan inside that one block then gives the exact offset.
 * Prompts are kilobytes, so a scan costs nothing, and the chain earns its keep
 * elsewhere: grouping many prefixes without diffing any of them.
 */

export interface Divergence {
  /** Offset into the canonical stream where the two first differ. */
  byteOffset: number;
  /** Leading blocks that are byte identical. */
  sharedBlocks: number;
  /** Leading bytes that are identical, which is the offset itself. */
  sharedBytes: number;
  blockIndex: number;
  blockKind: BlockKind;
  role?: string;
  partIndex: number | null;
  partType: Part['type'] | null;
  /** Offset within the diverging piece of content, rather than within framing. */
  offsetInPart: number | null;
  /** True when one prefix simply ends where the other continues. */
  isTruncation: boolean;
}

function firstDifferingByte(a: Buffer, b: Buffer): number {
  const limit = Math.min(a.length, b.length);

  // Word at a time over the bulk, then byte at a time inside the word that
  // differs. Plain enough to be obviously correct, fast enough for any prompt.
  const words = limit - (limit % 4);
  let i = 0;
  for (; i < words; i += 4) {
    if (a.readUInt32LE(i) !== b.readUInt32LE(i)) break;
  }
  for (; i < limit; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : limit;
}

function sharedBlockCount(a: SerializedPrefix, b: SerializedPrefix): number {
  const limit = Math.min(a.chain.length, b.chain.length);
  let shared = 0;
  while (shared < limit && a.chain[shared] === b.chain[shared]) shared += 1;
  return shared;
}

/**
 * Where two prefixes first differ, or null when they are identical.
 *
 * `blocks` describes the left side and is used only to name the location.
 */
export function firstDivergence(
  left: SerializedPrefix,
  right: SerializedPrefix,
  blocks: CanonicalPrefix,
): Divergence | null {
  const byteOffset = firstDifferingByte(left.bytes, right.bytes);
  if (byteOffset < 0) return null;

  const sharedBlocks = sharedBlockCount(left, right);
  const entry: OffsetEntry | null = locate(left.map, byteOffset);
  const isTruncation = byteOffset >= Math.min(left.bytes.length, right.bytes.length);

  const blockIndex = entry ? entry.blockIndex : Math.min(sharedBlocks, Math.max(0, blocks.length - 1));
  const block = blocks.find((candidate) => candidate.index === blockIndex);

  return {
    byteOffset,
    sharedBlocks,
    sharedBytes: byteOffset,
    blockIndex,
    blockKind: block?.kind ?? 'message',
    ...(block?.role ? { role: block.role } : {}),
    partIndex: entry ? entry.partIndex : null,
    partType: entry ? entry.type : null,
    offsetInPart: entry && entry.type !== 'binary' ? byteOffset - entry.payloadStart : null,
    isTruncation,
  };
}

export interface SharedPrefix {
  /** Blocks that every prefix shares in full. */
  blocks: number;
  /** Bytes every prefix shares, including a partial block. */
  bytes: number;
  /** The shared content itself, so it can be measured in tokens. */
  prefix: CanonicalPrefix;
  /** True when every prefix compared was identical. */
  complete: boolean;
}

/**
 * The longest prefix every one of these shares.
 *
 * This is the number that decides whether caching pays. A provider matches on
 * the longest prefix a request has in common with an earlier one, so what the
 * application repeats across its whole traffic pattern is what gets cached, not
 * what any single request happens to contain.
 */
export function sharedPrefix(prefixes: CanonicalPrefix[]): SharedPrefix {
  const first = prefixes[0];
  if (!first || prefixes.length === 0) return { blocks: 0, bytes: 0, prefix: [], complete: true };

  const serialised = prefixes.map((prefix) => serializePrefix(prefix));
  const base = serialised[0] as SerializedPrefix;

  let bytes = base.bytes.length;
  let blocks = base.chain.length;
  let complete = true;

  for (let i = 1; i < serialised.length; i += 1) {
    const other = serialised[i] as SerializedPrefix;
    const divergence = firstDivergence(base, other, first);
    if (!divergence) continue;
    complete = false;
    bytes = Math.min(bytes, divergence.sharedBytes);
    blocks = Math.min(blocks, divergence.sharedBlocks);
  }

  return { blocks, bytes, prefix: truncatePrefix(first, base, bytes), complete };
}
