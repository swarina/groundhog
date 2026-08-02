import { describe, expect, it } from 'vitest';
import { checkStablePrefix, expectStablePrefix, PrefixInstabilityError } from '../src/assert/index.js';
import { renderStabilityReport } from '../src/report/stability.js';

/**
 * These drive the assertion end to end: a builder returning provider shaped
 * bodies, run across the matrix, summarised, and rendered. Each builder carries
 * a known drift so the finding can be checked against a cause.
 */

const stable = 'You are a support agent. Answer only from the knowledge base below. '.repeat(120);

function body(systemText: string) {
  return {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'question' }],
  };
}

const opts = { provider: 'anthropic', model: 'claude-sonnet-4-5', discover: false, clockInstantMs: 1_700_000_000_000 };

describe('checkStablePrefix', () => {
  it('passes a builder that emits the same bytes every time', async () => {
    const report = await checkStablePrefix(() => body(stable), opts);
    expect(report.ok).toBe(true);
    expect(report.shared.complete).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it('fails a builder that interpolates a per call value', async () => {
    const report = await checkStablePrefix(() => body(stable + 'trace ' + Math.random()), opts);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('GH120');
  });

  it('reports the effective shared prefix in tokens', async () => {
    const report = await checkStablePrefix(() => body(stable + Math.random()), opts);
    expect(report.shared.tokens.value).toBeGreaterThan(100);
    expect(report.shared.tokens.value).toBeLessThan(report.shared.fullTokens.value);
  });

  it('attaches a diff that shows the differing span', async () => {
    const report = await checkStablePrefix(() => body(stable + 'seed ' + Math.random()), opts);
    const finding = report.findings[0];
    expect(finding?.diff).toBeDefined();
    expect(finding?.diff?.some((line) => line.startsWith('- '))).toBe(true);
    expect(finding?.diff?.some((line) => line.startsWith('+ '))).toBe(true);
  });

  it('names a date and places it in the environment', async () => {
    // Date granularity keeps the unpatched baseline axis from racing a tick.
    const report = await checkStablePrefix(() => body(stable + 'today is ' + new Date().toISOString().slice(0, 10)), opts);
    const finding = report.findings[0];
    expect(finding?.title).toContain('timestamp');
    expect(finding?.detail.join(' ')).toContain('environment');
  });

  it('places per input drift with the request data', async () => {
    const report = await checkStablePrefix((input: { tenant: string }) => body(stable + 'tenant: ' + input.tenant), {
      ...opts,
      inputs: [{ tenant: 'acme' }, { tenant: 'globex' }],
    });
    const finding = report.findings[0];
    expect(finding?.detail.join(' ')).toContain('per request data');
  });

  it('flags a stable prefix that is too short to cache', async () => {
    const report = await checkStablePrefix(() => body('short and stable'), opts);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('GH102');
  });

  it('carries the cost of the tokens that fall out of cache', async () => {
    const report = await checkStablePrefix(() => body(stable + Math.random()), opts);
    expect(report.findings[0]?.cost?.uncachedTokens).toBeGreaterThan(0);
  });
});

describe('expectStablePrefix', () => {
  it('returns quietly for a stable builder', async () => {
    await expect(expectStablePrefix(() => body(stable), opts)).resolves.toBeUndefined();
  });

  it('throws a rendered report for an unstable builder', async () => {
    await expect(expectStablePrefix(() => body(stable + Math.random()), opts)).rejects.toBeInstanceOf(PrefixInstabilityError);
  });

  it('puts the byte offset and the fix in the thrown message', async () => {
    try {
      await expectStablePrefix(() => body(stable + 'seed ' + Math.random()), opts);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PrefixInstabilityError);
      const message = (error as Error).message;
      expect(message).toContain('shared prefix');
      expect(message).toContain('Fix:');
    }
  });
});

describe('stability rendering', () => {
  it('states the shared prefix and the environments exercised', async () => {
    const report = await checkStablePrefix(() => body(stable + Math.random()), opts);
    const output = renderStabilityReport(report, { color: false, width: 80 });
    expect(output).toContain('shared prefix');
    expect(output).toContain('environments exercised');
    expect(output).toContain('clock-moved');
  });

  it('wraps to the width and uses no decorative characters', async () => {
    const report = await checkStablePrefix(() => body(stable + 'seed ' + Math.random()), opts);
    const output = renderStabilityReport(report, { color: false, width: 80 });
    for (const line of output.split('\n')) expect(line.length).toBeLessThanOrEqual(84);
    expect(output).not.toMatch(/[─│┌┐└┘]/);
    expect(output).not.toMatch(/[–—]/);
  });

  it('warns that a builder run measured builder output, not the wire', async () => {
    // A builder based check cannot see what the sdk sends, so the output has to
    // say so rather than implying it measured the real bytes.
    const report = await checkStablePrefix(() => body(stable), opts);
    expect(report.fidelity).toBe('builder');
    const output = renderStabilityReport(report, { color: false, width: 80 });
    expect(output).toContain('builder output');
    expect(output).toContain('not the bytes an sdk sends');
  });
});
