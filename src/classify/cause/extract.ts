import type { MatrixResult } from '../../runner/matrix.js';
import type { Part } from '../../types.js';

/**
 * Pulling the value that varies out of every run at the point of divergence.
 *
 * The classifier decides what a changing value is: a timestamp, a uuid, a
 * counter. To do that it needs the value as each run produced it, not just the
 * single differing byte. The shared prefix ends inside the value, so the value
 * is recovered by expanding from the divergence to its natural boundaries in
 * each run's own content.
 */

export interface Variant {
  runIndex: number;
  axis: string;
  inputIndex: number;
  repeatIndex: number;
  /** The token that varies, as this run produced it. */
  value: string;
}

export interface Variants {
  variants: Variant[];
  distinct: string[];
  /** True when the region that differs is wider than the extracted token. */
  spanExtendsBeyondToken: boolean;
}

/** Content of the part a divergence points at, or null when it has none. */
function partText(part: Part | undefined): string | null {
  if (!part) return null;
  if (part.type === 'text') return part.text;
  if (part.type === 'json') return part.canonical;
  return null;
}

/**
 * A value ends at whitespace or at a json string quote, and nowhere else.
 *
 * Colons, dots, and hyphens stay inside the token because timestamps, uuids and
 * paths are built from them. Trailing sentence punctuation is trimmed after, so
 * a timestamp at the end of a sentence still parses.
 */
function isBoundary(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '"';
}

function expandLeft(text: string, offset: number): number {
  let i = offset;
  while (i > 0 && !isBoundary(text[i - 1] as string)) i -= 1;
  return i;
}

function expandRight(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && !isBoundary(text[i] as string)) i += 1;
  return i;
}

function trimTrailingPunctuation(token: string): string {
  return token.replace(/[.,;:!?)]+$/, '');
}

/** Byte offset to character index in a utf-8 string. */
function byteToCharIndex(text: string, byteOffset: number): number {
  const upTo = Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8');
  return upTo.length;
}

export function extractVariants(result: MatrixResult): Variants | null {
  const divergence = result.divergence;
  if (!divergence || divergence.partIndex == null || divergence.offsetInPart == null) return null;

  const reference = result.runs[0];
  if (!reference) return null;

  const refBlock = reference.prefix.find((block) => block.index === divergence.blockIndex);
  const refText = partText(refBlock?.parts[divergence.partIndex]);
  if (refText == null) return null;

  const charOffset = byteToCharIndex(refText, divergence.offsetInPart);
  // The left boundary sits inside the shared prefix, so it is the same character
  // index in every run, and the content after each run's token can be compared
  // against the reference to see whether the change is confined to the token.
  const start = expandLeft(refText, charOffset);
  const refEnd = expandRight(refText, charOffset);
  const refAfter = refText.slice(refEnd);

  const variants: Variant[] = [];
  let spanExtendsBeyondToken = false;

  for (const run of result.runs) {
    const block = run.prefix.find((candidate) => candidate.index === divergence.blockIndex);
    const text = partText(block?.parts[divergence.partIndex]);
    if (text == null) continue;

    const end = expandRight(text, Math.min(charOffset, text.length));
    const value = trimTrailingPunctuation(text.slice(start, end));

    // Content after the token that still differs means the change is not a lone
    // volatile value, which keeps a genuine content edit from being mislabelled.
    if (run !== reference && text.slice(end) !== refAfter) spanExtendsBeyondToken = true;

    variants.push({
      runIndex: run.descriptor.index,
      axis: run.descriptor.axis,
      inputIndex: run.descriptor.inputIndex,
      repeatIndex: run.descriptor.repeatIndex,
      value,
    });
  }

  if (variants.length === 0) return null;
  const distinct = [...new Set(variants.map((variant) => variant.value))];
  return { variants, distinct, spanExtendsBeyondToken };
}
