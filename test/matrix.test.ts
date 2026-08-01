import { describe, expect, it } from 'vitest';
import { runMatrix } from '../src/runner/matrix.js';

/**
 * The builders here return anthropic shaped bodies, because the matrix parses
 * whatever a builder returns through a provider adapter before comparing. Each
 * builder embeds a specific drift so the partition and the divergence can be
 * checked against a known cause.
 */

function body(systemText: string) {
  return {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hello' }],
  };
}

const base = 'You are a support agent. Answer using the knowledge base. '.repeat(20);

const opts = { provider: 'anthropic', model: 'claude-sonnet-4-5', clockInstantMs: 1_700_000_000_000 };

describe('matrix runner', () => {
  it('reports a stable builder as stable', async () => {
    const result = await runMatrix(() => body(base), opts);
    expect(result.partition.shape).toBe('stable');
    expect(result.shared.complete).toBe(true);
    expect(result.divergence).toBeNull();
  });

  it('catches a value that changes on every call', async () => {
    // The seeded axes pin Math.random, but the baseline axis does not, so its
    // repeats differ and that is enough to name per call variation.
    const result = await runMatrix(() => body(base + 'trace ' + Math.random()), opts);
    expect(result.partition.shape).toBe('varies-per-run');
    expect(result.divergence).not.toBeNull();
  });

  it('catches a date that only rolls over between environments', async () => {
    // A date is stable across repeats within a day, so a repeat only check sees
    // nothing. Moving the clock 26 hours crosses a day boundary and reveals it.
    // Date granularity is used rather than a millisecond timestamp so the
    // unpatched baseline axis does not race a clock tick.
    const result = await runMatrix(() => body(base + 'today is ' + new Date().toISOString().slice(0, 10)), opts);
    expect(result.partition.shape).toBe('varies-by-environment');
    expect(result.partition.dimension).toBe('environment');
  });

  it('catches per input data sitting above the boundary', async () => {
    const result = await runMatrix((input: { user: string }) => body(base + 'user: ' + input.user), {
      ...opts,
      inputs: [{ user: 'alice' }, { user: 'bob' }],
    });
    expect(result.partition.shape).toBe('varies-by-input');
    expect(result.partition.dimension).toBe('input');
  });

  it('locates where a divergence begins, in content bytes', async () => {
    const result = await runMatrix(() => body(base + 'seed ' + Math.random()), opts);
    expect(result.divergence?.blockIndex).toBe(0);
    // The drift sits after the shared base and the fixed "seed " label.
    expect(result.divergence?.offsetInPart).toBeGreaterThanOrEqual(base.length);
    expect(result.divergence?.contentByteOffset).toBeGreaterThanOrEqual(base.length);
  });

  it('measures a shared prefix that stops before the drift', async () => {
    const result = await runMatrix(() => body(base + 'x'.repeat(5) + Math.random()), opts);
    expect(result.shared.complete).toBe(false);
    expect(result.shared.prefix.length).toBeGreaterThan(0);
  });

  it('names the axes it ran so the reader knows what was exercised', async () => {
    const result = await runMatrix(() => body(base), opts);
    const labels = result.axes.map((axis) => axis.label);
    expect(labels).toContain('baseline');
    expect(labels).toContain('clock-moved');
    expect(labels).toContain('timezone-shifted');
  });

  it('runs only the baseline when perturbation is turned off', async () => {
    const result = await runMatrix(() => body(base), { ...opts, perturb: false });
    expect(result.axes).toHaveLength(1);
    expect(result.axes[0]?.label).toBe('baseline');
  });

  it('awaits an asynchronous builder', async () => {
    const result = await runMatrix(async () => {
      await Promise.resolve();
      return body(base);
    }, opts);
    expect(result.partition.shape).toBe('stable');
  });
});

describe('perturbation is fully restored', () => {
  it('leaves the real clock and random stream in place afterwards', async () => {
    const realNow = Date.now();
    await runMatrix(() => body(base + Math.random()), opts);

    // If the frozen clock or the seeded random had leaked, these would be
    // pinned rather than live.
    expect(Date.now()).toBeGreaterThanOrEqual(realNow);
    const a = Math.random();
    const b = Math.random();
    expect(a).not.toBe(b);
    expect(process.env.TZ).toBeUndefined();
  });
});
