import { estimateText } from '../tokens/estimate.js';
import type { Conclusion, Probe, ProbeStep } from './types.js';

/**
 * The probe definitions.
 *
 * Each probe is a short script of requests and a reading of the usage that
 * comes back. The reading is deliberately conservative: a probe concludes only
 * what the observations demonstrate, and reports the fact as unknown when the
 * result is ambiguous, so a run never writes a measured value it cannot stand
 * behind.
 */

/** Builds provider appropriate request bodies with a controllable prefix. */
export interface RequestShaper {
  /** A request whose cacheable prefix is the given text. */
  withPrefix(text: string): unknown;
  /** A request whose cacheable prefix is a list of tools in the given order. */
  withTools(toolNames: string[]): unknown;
}

const SENTENCE = 'You are a support agent who answers questions from the knowledge base provided. ';

/** Text estimated at roughly the requested number of tokens. */
export function fillerForTokens(tokens: number): string {
  let text = '';
  while (estimateText(text, 'text') < tokens) text += SENTENCE;
  return text.trim();
}

function pair(shaper: RequestShaper, tokens: number): ProbeStep[] {
  const text = fillerForTokens(tokens);
  return [
    { label: `${tokens} tokens, write`, body: shaper.withPrefix(text) },
    { label: `${tokens} tokens, read`, body: shaper.withPrefix(text) },
  ];
}

/** Caching works here, and our prefix model matches what the provider hashes. */
export function worksAtAll(shaper: RequestShaper): Probe {
  const steps = pair(shaper, 4096);
  return {
    id: 'works-at-all',
    question: 'does caching work here, and does our prefix match what the provider hashes',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      const read = observations[1];
      if (read?.hit) return fact('caching.mode', 'confirmed', 'a repeated prefix was served from cache, so caching works and our prefix model matches');
      return unknown('caching.mode', 'a repeated prefix did not hit; either caching is off or our prefix does not match what the provider sends');
    },
  };
}

/** The real minimum cacheable length for this model. */
export function threshold(shaper: RequestShaper, candidates: number[] = [512, 1024, 2048, 4096, 8192]): Probe {
  const sizes = [...candidates].sort((a, b) => a - b);
  const steps = sizes.flatMap((size) => pair(shaper, size));
  return {
    id: 'threshold',
    question: 'what is the smallest prefix this model will cache',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      // Observations arrive as write, read, write, read, per size.
      for (let i = 0; i < sizes.length; i += 1) {
        const read = observations[i * 2 + 1];
        if (read?.hit) {
          const size = sizes[i] as number;
          return fact('model.minCacheableTokens', size, `a ${size} token prefix was cached and a smaller one was not, so the minimum is at or below ${size}`);
        }
      }
      return unknown('model.minCacheableTokens', 'no candidate prefix was cached, so the minimum is above the largest size tried');
    },
  };
}

/** Whether a trailing space inside the cached span breaks the match. */
export function whitespaceSignificance(shaper: RequestShaper): Probe {
  const text = fillerForTokens(4096);
  const steps: ProbeStep[] = [
    { label: 'warm the prefix', body: shaper.withPrefix(text) },
    { label: 'same prefix', body: shaper.withPrefix(text) },
    { label: 'prefix with a trailing space', body: shaper.withPrefix(text + ' ') },
  ];
  return {
    id: 'whitespace',
    question: 'does a trailing space inside the cached span break the match',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      const control = observations[1];
      const spaced = observations[2];
      if (!control?.hit) return unknown('caching.whitespaceSensitive', 'the control prefix did not hit, so the whitespace result cannot be read');
      if (spaced?.hit) return fact('caching.whitespaceSensitive', false, 'a trailing space still hit, so this provider normalises trailing whitespace away');
      return fact('caching.whitespaceSensitive', true, 'a trailing space missed, so whitespace is significant to the cache here');
    },
  };
}

/** Whether tool definition order participates in the cache key. */
export function toolOrder(shaper: RequestShaper): Probe {
  const forward = ['alpha_tool', 'beta_tool', 'gamma_tool'];
  const reordered = ['gamma_tool', 'alpha_tool', 'beta_tool'];
  const steps: ProbeStep[] = [
    { label: 'tools in one order', body: shaper.withTools(forward) },
    { label: 'same order again', body: shaper.withTools(forward) },
    { label: 'tools reordered', body: shaper.withTools(reordered) },
  ];
  return {
    id: 'tool-order',
    question: 'does the order of tool definitions change the cache key',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      const control = observations[1];
      const reorderedObs = observations[2];
      if (!control?.hit) return unknown('caching.toolOrderSensitive', 'the control did not hit, so the reordering result cannot be read');
      if (reorderedObs?.hit) return fact('caching.toolOrderSensitive', false, 'reordered tools still hit, so this provider does not key on tool order');
      return fact('caching.toolOrderSensitive', true, 'reordered tools missed, so tool order is part of the cache key and must be stable');
    },
  };
}

/** Whether the provider normalises unicode before it hashes the prompt. */
export function unicodeNormalisation(shaper: RequestShaper): Probe {
  const base = fillerForTokens(4096);
  // The accented word differs only in its normal form: one composed codepoint
  // versus a base letter and a combining accent. The rest is ascii, so nothing
  // else moves.
  const composed = base + ' status: caf\u00e9 review complete';
  const decomposed = base + ' status: cafe\u0301 review complete';
  const steps: ProbeStep[] = [
    { label: 'warm the composed form', body: shaper.withPrefix(composed) },
    { label: 'same composed form', body: shaper.withPrefix(composed) },
    { label: 'decomposed form of the same text', body: shaper.withPrefix(decomposed) },
  ];
  return {
    id: 'unicode',
    question: 'does the provider normalise unicode before it hashes the prompt',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      const control = observations[1];
      const decomposedObs = observations[2];
      if (!control?.hit) return unknown('caching.unicodeNormalised', 'the control did not hit, so the normalisation result cannot be read');
      if (decomposedObs?.hit) return fact('caching.unicodeNormalised', true, 'the decomposed form still hit, so this provider normalises unicode and equivalent text shares a cache entry');
      return fact('caching.unicodeNormalised', false, 'the decomposed form missed, so unicode is not normalised and equivalent text must be produced in the same normal form');
    },
  };
}

/**
 * The cache step size, read from the cached token counts.
 *
 * The provider reports how many tokens it served from cache, so sending
 * prefixes of several sizes and reading the cached counts back reveals the step
 * directly, without needing to know the exact token count of any prefix.
 */
export function granularity(shaper: RequestShaper, sizes: number[] = [1100, 1250, 1400, 1550]): Probe {
  const steps = sizes.flatMap((size) => pair(shaper, size));
  return {
    id: 'granularity',
    question: 'does the provider cache in fixed steps, and how large is the step',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: 0,
    interpret(observations) {
      const cached = sizes
        .map((_, i) => observations[i * 2 + 1])
        .filter((obs): obs is NonNullable<typeof obs> => obs != null && obs.hit)
        .map((obs) => obs.usage.cacheRead)
        .sort((a, b) => a - b);

      if (cached.length < 2) return unknown('caching.cacheGranularityTokens', 'too few prefixes were cached to read a step size');

      // The step is the smallest gap between distinct cached counts. When the
      // provider does not round, the counts vary freely and no clean step shows.
      const gaps: number[] = [];
      for (let i = 1; i < cached.length; i += 1) {
        const gap = (cached[i] as number) - (cached[i - 1] as number);
        if (gap > 0) gaps.push(gap);
      }
      if (gaps.length === 0) return unknown('caching.cacheGranularityTokens', 'the cached counts did not differ, so a step size could not be read');

      const step = gaps.reduce((g, value) => gcd(g, value), gaps[0] as number);
      if (step >= 8 && gaps.every((gap) => gap % step === 0)) {
        return fact('caching.cacheGranularityTokens', step, `cached counts landed on multiples of ${step} tokens, so the cache rounds down to a ${step} token step`);
      }
      return fact('caching.cacheGranularityTokens', 1, 'cached counts did not fall on a consistent step, so the cache appears not to round');
    },
  };
}

/**
 * The time to live, from whether a prefix still hits after a gap.
 *
 * This is the slow probe: it waits real minutes on a real run, so it is off by
 * default and included only when asked. Each gap uses a fresh prefix so the
 * waits do not interfere with each other.
 */
export function timeToLive(shaper: RequestShaper, gapSeconds: number[] = [240, 360, 660]): Probe {
  const gaps = [...gapSeconds].sort((a, b) => a - b);
  const base = fillerForTokens(4096);
  const steps: ProbeStep[] = gaps.flatMap((gap, i) => [
    { label: `warm prefix ${i + 1}`, body: shaper.withPrefix(`${base} probe ${i}`) },
    { label: `read prefix ${i + 1} after ${gap} seconds`, body: shaper.withPrefix(`${base} probe ${i}`), waitSecondsBefore: gap },
  ]);
  return {
    id: 'ttl',
    question: 'how long does a cached prefix survive without traffic',
    steps,
    requestCount: steps.length,
    maxWaitSeconds: gaps[gaps.length - 1] ?? 0,
    interpret(observations) {
      let longestHit = 0;
      let shortestMiss = Number.POSITIVE_INFINITY;
      gaps.forEach((gap, i) => {
        const read = observations[i * 2 + 1];
        if (!read) return;
        if (read.hit) longestHit = Math.max(longestHit, gap);
        else shortestMiss = Math.min(shortestMiss, gap);
      });

      if (longestHit === 0 && shortestMiss === Number.POSITIVE_INFINITY) {
        return unknown('caching.ttlSeconds', 'no read produced a usable result');
      }
      if (shortestMiss === Number.POSITIVE_INFINITY) {
        return fact('caching.ttlSeconds', longestHit, `the prefix still hit after ${longestHit} seconds, so the time to live is at least that`);
      }
      if (longestHit === 0) {
        return fact('caching.ttlSeconds', 0, `the prefix had already expired by ${shortestMiss} seconds, so the time to live is below that`);
      }
      return fact('caching.ttlSeconds', longestHit, `the prefix hit at ${longestHit} seconds and had expired by ${shortestMiss}, so the time to live is between them`);
    },
  };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export const CORE_PROBES = [worksAtAll, threshold, whitespaceSignificance, toolOrder, unicodeNormalisation, granularity] as const;

export interface BuildOptions {
  /** Include the time to live probe, which waits real minutes on a real run. */
  includeTtl?: boolean;
}

export function buildProbes(shaper: RequestShaper, options: BuildOptions = {}): Probe[] {
  const probes = CORE_PROBES.map((make) => make(shaper));
  if (options.includeTtl) probes.push(timeToLive(shaper));
  return probes;
}

function fact(field: string, value: unknown, note: string): Conclusion {
  return { fact: field, value, confidence: 'observed', note };
}

function unknown(field: string, note: string): Conclusion {
  return { fact: field, value: null, confidence: 'unknown', note };
}
