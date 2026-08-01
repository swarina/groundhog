import { describe, expect, it } from 'vitest';
import { computePrefix } from '../src/baseline/lockfile.js';
import { buildProbes, threshold, toolOrder, whitespaceSignificance, worksAtAll } from '../src/conformance/probes.js';
import { anthropicShaper, openaiShaper } from '../src/conformance/shapers.js';
import { runProbe, runProbes, planRun } from '../src/conformance/runner.js';
import { buildPatch, hasObservations } from '../src/conformance/patch.js';
import type { Sender } from '../src/conformance/types.js';

/**
 * A simulated provider with known caching parameters. The probes are pointed at
 * it and must recover those parameters, which is how the probe logic is trusted
 * before it is ever pointed at a real key.
 *
 * The simulation is an exact prefix hash cache: a request hits when the same
 * prefix was seen before and the prefix clears the threshold. A normaliser can
 * be given to model a provider that ignores whitespace or tool order, so the
 * probes can be checked to distinguish a provider that keys on those from one
 * that does not.
 */
interface SimOptions {
  thresholdTokens: number;
  normalise?: (body: unknown) => unknown;
}

function simulatedProvider(options: SimOptions): Sender {
  const seen = new Set<string>();
  return async (rawBody: unknown) => {
    const body = options.normalise ? options.normalise(rawBody) : rawBody;
    const { prefixHash, tokens } = computePrefix(body, { discover: false });
    const isRepeat = seen.has(prefixHash);
    seen.add(prefixHash);
    if (isRepeat && tokens >= options.thresholdTokens) {
      return { usage: { cacheRead: tokens, cacheWrite: 0, uncached: 0 } };
    }
    return { usage: { cacheRead: 0, cacheWrite: tokens, uncached: 0 } };
  };
}

const shaper = anthropicShaper('claude-sonnet-4-5');
const instant = { sleep: async () => undefined };

describe('recovering the caching threshold', () => {
  it('finds a low threshold at the smallest candidate', async () => {
    const run = await runProbe(threshold(shaper), simulatedProvider({ thresholdTokens: 100 }), instant);
    expect(run.conclusion.value).toBe(512);
    expect(run.conclusion.confidence).toBe('observed');
  });

  it('finds a high threshold at a larger candidate', async () => {
    const run = await runProbe(threshold(shaper), simulatedProvider({ thresholdTokens: 3000 }), instant);
    expect(run.conclusion.value).toBe(4096);
  });

  it('reports unknown when nothing caches at all', async () => {
    const run = await runProbe(threshold(shaper), simulatedProvider({ thresholdTokens: 1_000_000 }), instant);
    expect(run.conclusion.confidence).toBe('unknown');
    expect(run.conclusion.value).toBeNull();
  });
});

describe('confirming caching works', () => {
  it('confirms when a repeated prefix hits', async () => {
    const run = await runProbe(worksAtAll(shaper), simulatedProvider({ thresholdTokens: 100 }), instant);
    expect(run.conclusion.value).toBe('confirmed');
  });

  it('reports no result when nothing ever hits', async () => {
    const run = await runProbe(worksAtAll(shaper), simulatedProvider({ thresholdTokens: 1_000_000 }), instant);
    expect(run.conclusion.confidence).toBe('unknown');
  });
});

describe('whitespace significance', () => {
  it('finds whitespace significant against an exact cache', async () => {
    const run = await runProbe(whitespaceSignificance(shaper), simulatedProvider({ thresholdTokens: 100 }), instant);
    expect(run.conclusion.value).toBe(true);
  });

  it('finds whitespace ignored when the provider normalises it', async () => {
    // Model a provider that strips trailing whitespace from the system text.
    const trimTrailing = (body: unknown) => {
      const b = structuredClone(body) as { system?: Array<{ text?: string }> };
      if (b.system?.[0]?.text) b.system[0].text = b.system[0].text.replace(/\s+$/, '');
      return b;
    };
    const run = await runProbe(whitespaceSignificance(shaper), simulatedProvider({ thresholdTokens: 100, normalise: trimTrailing }), instant);
    expect(run.conclusion.value).toBe(false);
  });
});

describe('tool order significance', () => {
  it('finds tool order significant against an exact cache', async () => {
    const run = await runProbe(toolOrder(shaper), simulatedProvider({ thresholdTokens: 1 }), instant);
    expect(run.conclusion.value).toBe(true);
  });

  it('finds tool order ignored when the provider sorts tools', async () => {
    const sortTools = (body: unknown) => {
      const b = structuredClone(body) as { tools?: Array<{ name: string }> };
      if (b.tools) b.tools = [...b.tools].sort((x, y) => x.name.localeCompare(y.name));
      return b;
    };
    const run = await runProbe(toolOrder(shaper), simulatedProvider({ thresholdTokens: 1, normalise: sortTools }), instant);
    expect(run.conclusion.value).toBe(false);
  });
});

describe('a full run and its patch', () => {
  it('produces a datestamped override from what it measured', async () => {
    const runs = await runProbes(buildProbes(shaper), simulatedProvider({ thresholdTokens: 1500 }), instant);
    expect(hasObservations(runs)).toBe(true);

    const patch = buildPatch(runs, { provider: 'anthropic', model: 'claude-sonnet-4-5', date: '2026-08-02' }) as {
      providers: { anthropic: { lastVerified: string; models?: { 'claude-sonnet-4-5'?: { minCacheableTokens?: { value: number; confidence: string } } } } };
    };

    expect(patch.providers.anthropic.lastVerified).toBe('2026-08-02');
    const minimum = patch.providers.anthropic.models?.['claude-sonnet-4-5']?.minCacheableTokens;
    expect(minimum?.value).toBe(2048);
    expect(minimum?.confidence).toBe('observed');
  });

  it('plans the request count before anything is sent', () => {
    const plan = planRun(buildProbes(shaper));
    expect(plan.totalRequests).toBeGreaterThan(0);
    expect(plan.maxWaitSeconds).toBe(0);
  });
});

describe('the openai request shape', () => {
  it('recovers a threshold through the implicit caching shape', async () => {
    // OpenAI has no cache marker, so the shaper puts the prefix in a system
    // message and the comparable prefix drops the trailing user turn.
    const run = await runProbe(threshold(openaiShaper('gpt-4o')), simulatedProvider({ thresholdTokens: 100 }), instant);
    expect(run.conclusion.value).toBe(512);
  });
});
