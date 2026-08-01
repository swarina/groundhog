import type { MatrixResult } from '../../runner/matrix.js';
import type { Block, Part } from '../../types.js';
import { VALUE_DETECTORS } from './detectors.js';
import { extractVariants } from './extract.js';
import type { Cause, CauseContext } from './types.js';

/**
 * Naming the cause of a divergence.
 *
 * Ordering is checked first, because a set of reordered elements differs at the
 * first element and would otherwise look like a value change. Then the value
 * detectors run over the token that varies. Whatever no detector claims is a
 * content change, which is a real answer rather than a shrug: the cached part
 * genuinely holds different content on different runs.
 */
export function classifyCause(result: MatrixResult): Cause {
  const divergence = result.divergence;

  if (divergence?.isStructural && !divergence.isTruncation) {
    const ordering = detectOrdering(result);
    if (ordering) return ordering;
    return {
      kind: 'structural',
      confidence: 'certain',
      observation: 'the runs differ in the shape of the prompt, not only its text: a block or part was added, removed, or retyped',
    };
  }

  const ordering = detectOrdering(result);
  if (ordering) return ordering;

  const variants = extractVariants(result);
  if (variants) {
    const context: CauseContext = {
      variants: variants.variants,
      distinct: variants.distinct,
      partition: result.partition,
      spanExtendsBeyondToken: variants.spanExtendsBeyondToken,
    };

    const matches = VALUE_DETECTORS.map((detector) => detector.detect(context))
      .filter((cause): cause is Cause => cause !== null)
      .sort((a, b) => precedence(a) - precedence(b));

    const best = matches[0];
    if (best) return best;

    return {
      kind: 'content',
      confidence: 'probable',
      observation: 'the value that changes is not a recognised volatile pattern, so the cached part is carrying content that genuinely differs',
      example: { left: variants.distinct[0] ?? '', right: variants.distinct[1] ?? '' },
    };
  }

  return {
    kind: 'content',
    confidence: 'possible',
    observation: 'the runs differ but the changing region could not be isolated to a single value',
  };
}

const PRECEDENCE: Record<Cause['kind'], number> = {
  structural: 10,
  timestamp: 20,
  uuid: 30,
  counter: 40,
  ordering: 50,
  random: 60,
  content: 70,
};

function precedence(cause: Cause): number {
  return PRECEDENCE[cause.kind];
}

function partText(part: Part | undefined): string | null {
  if (!part) return null;
  if (part.type === 'text') return part.text;
  if (part.type === 'json') return part.canonical;
  return null;
}

/**
 * Reordering, checked at the levels it actually happens.
 *
 * Retrieved documents come back in a different rank order, tool definitions are
 * assembled from an unordered registry, json array elements are built from a
 * set. Each shows up as a permutation of the same elements, which is exact
 * multiset equality with a different sequence.
 */
function detectOrdering(result: MatrixResult): Cause | null {
  const reference = result.runs[0];
  const other = result.runs.find((run) => run.descriptor.hash !== reference?.descriptor.hash);
  if (!reference || !other) return null;

  const blockOrder = detectBlockReorder(reference.prefix, other.prefix);
  if (blockOrder) return blockOrder;

  const div = result.divergence;
  if (div) {
    const refBlock = reference.prefix.find((block) => block.index === div.blockIndex);
    const otherBlock = other.prefix.find((block) => block.index === div.blockIndex);
    if (refBlock && otherBlock) {
      const partOrder = detectPartReorder(refBlock.parts, otherBlock.parts);
      if (partOrder) return partOrder;
    }
    if (div.partIndex != null) {
      const refText = partText(refBlock?.parts[div.partIndex]);
      const otherText = partText(otherBlock?.parts[div.partIndex]);
      if (refText != null && otherText != null) {
        const lines = detectLineReorder(refText, otherText);
        if (lines) return lines;
      }
    }
  }

  return null;
}

/** The same parts of a block in a different order, which is how a tool list assembled from a set appears. */
function detectPartReorder(left: Part[], right: Part[]): Cause | null {
  if (left.length !== right.length || left.length < 3) return null;
  const leftKeys = left.map(partSignature);
  const rightKeys = right.map(partSignature);
  if (!isPermutation(leftKeys, rightKeys) || sameOrder(leftKeys, rightKeys)) return null;
  return {
    kind: 'ordering',
    confidence: 'certain',
    observation: 'the block holds the same items in a different order, which is how a tool list assembled without a stable sort appears',
  };
}

function detectBlockReorder(left: Block[], right: Block[]): Cause | null {
  if (left.length !== right.length || left.length < 3) return null;
  const key = (block: Block) => block.kind + ':' + block.parts.map((part) => partSignature(part)).join('|');
  const leftKeys = left.map(key);
  const rightKeys = right.map(key);
  if (!isPermutation(leftKeys, rightKeys) || sameOrder(leftKeys, rightKeys)) return null;
  return {
    kind: 'ordering',
    confidence: 'certain',
    observation: 'the blocks carry the same content in a different order, which is a set of blocks assembled without a stable sort',
  };
}

function partSignature(part: Part): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'json') return part.canonical;
  return part.sha256;
}

function detectLineReorder(left: string, right: string): Cause | null {
  const leftLines = significantLines(left);
  const rightLines = significantLines(right);
  if (leftLines.length < 3 || !isPermutation(leftLines, rightLines) || sameOrder(leftLines, rightLines)) return null;
  return {
    kind: 'ordering',
    confidence: 'certain',
    observation: 'the block holds the same lines in a different order, which is how retrieved documents in an unstable rank order appear',
  };
}

/** Non-trivial lines, so a reordering claim is not made on incidental blank lines. */
function significantLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 24);
}

function isPermutation(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of b) {
    const count = counts.get(item);
    if (!count) return false;
    counts.set(item, count - 1);
  }
  return [...counts.values()].every((count) => count === 0);
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
