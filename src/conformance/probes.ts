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

export const CORE_PROBES = [worksAtAll, threshold, whitespaceSignificance, toolOrder] as const;

export function buildProbes(shaper: RequestShaper): Probe[] {
  return CORE_PROBES.map((make) => make(shaper));
}

function fact(field: string, value: unknown, note: string): Conclusion {
  return { fact: field, value, confidence: 'observed', note };
}

function unknown(field: string, note: string): Conclusion {
  return { fact: field, value: null, confidence: 'unknown', note };
}
