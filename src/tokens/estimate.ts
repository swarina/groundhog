import type { CanonicalPrefix, Part, ThresholdVerdict, TokenEstimate } from '../types.js';

/**
 * Offline token estimation.
 *
 * No provider publishes an offline tokenizer for every model we support, so the
 * default path estimates and carries an explicit error band. The band is the
 * point of this module: a bare point estimate compared against a threshold will
 * silently report that a span qualifies when it does not, which is the one
 * failure this tool must never produce.
 *
 * The model is a character class mixture rather than a flat characters per
 * token ratio, because prose, code, JSON schemas, and CJK text tokenize at very
 * different rates and prompts routinely contain all four.
 */

export interface TokenizerProfile {
  id: string;
  /** Base relative error, before content specific widening. */
  errorBandPct: number;
}

export const DEFAULT_TOKENIZER: TokenizerProfile = {
  id: 'mixture-heuristic-v2',
  errorBandPct: 12,
};

const MAX_BAND_PCT = 30;

interface CharCounts {
  cjk: number;
  digits: number;
  newlines: number;
  punctuation: number;
  wordish: number;
  total: number;
}

function classify(text: string): CharCounts {
  const counts: CharCounts = { cjk: 0, digits: 0, newlines: 0, punctuation: 0, wordish: 0, total: 0 };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    counts.total += 1;
    if (ch === '\n') {
      counts.newlines += 1;
    } else if (code >= 0x30 && code <= 0x39) {
      counts.digits += 1;
    } else if (isCjk(code)) {
      counts.cjk += 1;
    } else if (isPunctuation(ch, code)) {
      counts.punctuation += 1;
    } else {
      counts.wordish += 1;
    }
  }
  return counts;
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // cjk extension a
    (code >= 0x4e00 && code <= 0x9fff) || // cjk unified
    (code >= 0xac00 && code <= 0xd7af) || // hangul
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isPunctuation(ch: string, code: number): boolean {
  if (code < 0x80) {
    return !/[A-Za-z0-9\s]/.test(ch);
  }
  return false;
}

/**
 * Estimated tokens for one piece of content.
 *
 * Base ratios differ by content kind because structured payloads carry far more
 * punctuation per character than prose, and punctuation is dense in tokens.
 */
export function estimateText(text: string, kind: 'text' | 'json'): number {
  if (text.length === 0) return 0;
  const c = classify(text);

  // Coefficients fitted against the o200k_base tokenizer over the calibration
  // corpus. See calibration/README.md. CJK runs well under one token per
  // character on a modern tokenizer, not at one.
  const cjkTokens = c.cjk * 0.72;

  // Digits group into short runs rather than tokenizing individually.
  const digitTokens = c.digits / 3;

  // Newlines usually merge with surrounding whitespace rather than standing alone.
  const newlineTokens = c.newlines * 0.5;

  const remaining = c.wordish + c.punctuation;
  let latinTokens = 0;
  if (remaining > 0) {
    const punctRatio = c.punctuation / remaining;
    // Prose sits near 4.8 characters per token. Code is denser because its
    // punctuation mixes with identifiers, so a punctuation penalty applies to
    // text. Structured json punctuation merges into few tokens, so it gets no
    // penalty and a base close to prose.
    const effective =
      kind === 'json' ? 4.0 : clamp(4.7 - 3.0 * punctRatio, 3.3, 4.7);
    latinTokens = remaining / effective;
  }

  return Math.ceil(cjkTokens + digitTokens + newlineTokens + latinTokens);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bandFor(text: string, profile: TokenizerProfile): number {
  const c = classify(text);
  let band = profile.errorBandPct;
  if (c.total > 0) {
    if (c.cjk / c.total > 0.05) band += 8;
    const remaining = c.wordish + c.punctuation;
    if (remaining > 0 && c.punctuation / remaining > 0.3) band += 5;
  }
  if (c.total < 200) band += 5;
  return Math.min(band, MAX_BAND_PCT);
}

function partText(part: Part): { text: string; kind: 'text' | 'json' } | null {
  if (part.type === 'text') return { text: part.text, kind: 'text' };
  if (part.type === 'json') return { text: part.canonical, kind: 'json' };
  return null;
}

/** Estimate over a set of blocks, carrying a widened band and unknown part count. */
export function estimateBlocks(blocks: CanonicalPrefix, profile: TokenizerProfile = DEFAULT_TOKENIZER): TokenEstimate {
  let tokens = 0;
  let unknownParts = 0;
  let weightedBand = 0;
  let weight = 0;

  for (const block of blocks) {
    for (const part of block.parts) {
      const content = partText(part);
      if (!content) {
        unknownParts += 1;
        continue;
      }
      const t = estimateText(content.text, content.kind);
      tokens += t;
      const band = bandFor(content.text, profile);
      weightedBand += band * t;
      weight += t;
    }
  }

  const bandPct = weight > 0 ? weightedBand / weight : profile.errorBandPct;
  return {
    value: tokens,
    low: Math.floor(tokens * (1 - bandPct / 100)),
    high: Math.ceil(tokens * (1 + bandPct / 100)),
    bandPct: Math.round(bandPct * 10) / 10,
    method: 'estimate',
    unknownParts,
  };
}

/**
 * Compare an estimate against a threshold.
 *
 * Returns 'straddles' whenever the error band crosses the threshold, so a
 * caller can report uncertainty instead of asserting a verdict it cannot
 * support. Unknown parts always straddle, because the estimate is then a lower
 * bound with no upper bound at all.
 */
export function compareToThreshold(estimate: TokenEstimate, threshold: number): ThresholdVerdict {
  if (estimate.unknownParts > 0 && estimate.low < threshold) return 'straddles';
  if (estimate.low >= threshold) return 'above';
  if (estimate.high < threshold) return 'below';
  return 'straddles';
}
