import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { computePrefix } from '../src/baseline/lockfile.js';
import { buildProbes } from '../src/conformance/probes.js';
import { anthropicShaper } from '../src/conformance/shapers.js';
import { runProbes } from '../src/conformance/runner.js';
import { renderConformance } from '../src/report/conformance.js';
import type { ProbeRun, Sender } from '../src/conformance/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The conformance render is pinned from a run against a simulated provider whose
 * caching parameters are fixed. The probe conclusions are deterministic given
 * that provider, so the rendered output is too, and a change to the format shows
 * up as a diff to review. No real api and no wall clock are involved.
 */
/** A provider with a 1024 token floor and a 128 token step, so every probe reads a result. */
function simulatedProvider(floor: number, step: number): Sender {
  const seen = new Set<string>();
  return async (body: unknown) => {
    const { prefixHash, tokens } = computePrefix(body, { discover: false });
    const isRepeat = seen.has(prefixHash);
    seen.add(prefixHash);
    if (isRepeat && tokens >= floor) {
      const cached = floor + Math.floor((tokens - floor) / step) * step;
      return { usage: { cacheRead: cached, cacheWrite: 0, uncached: tokens - cached } };
    }
    return { usage: { cacheRead: 0, cacheWrite: tokens, uncached: 0 } };
  };
}

describe('conformance output', () => {
  let output = '';
  beforeAll(async () => {
    const runs: ProbeRun[] = await runProbes(buildProbes(anthropicShaper('claude-sonnet-4-5')), simulatedProvider(1024, 128), {
      sleep: async () => undefined,
    });
    output = renderConformance(runs, 'anthropic', 'claude-sonnet-4-5', { color: false, width: 80 });
  });

  it('matches the pinned output', () => {
    const goldenPath = join(HERE, 'golden', 'conformance-anthropic.txt');
    if (process.env['GROUNDHOG_UPDATE_GOLDEN'] === '1') {
      mkdirSync(join(HERE, 'golden'), { recursive: true });
      writeFileSync(goldenPath, output);
    }
    expect(existsSync(goldenPath), `missing golden file ${goldenPath}`).toBe(true);
    expect(output).toBe(readFileSync(goldenPath, 'utf8'));
  });

  it('stays inside the wrap width and uses no decorative characters', () => {
    for (const line of output.split('\n')) expect(line.length, `line too long: ${line}`).toBeLessThanOrEqual(84);
    expect(output).not.toMatch(/[─│┌┐└┘]/);
    expect(output).not.toMatch(/[–—]/);
  });

  it('shows a measured verdict and the question for each probe', () => {
    expect(output).toContain('measured');
    expect(output).toContain('smallest prefix this model will cache');
  });
});
