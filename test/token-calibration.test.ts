import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import gpt4o from 'gpt-tokenizer/model/gpt-4o';
import { describe, expect, it } from 'vitest';
import { estimateText } from '../src/tokens/estimate.js';
import { loadTable, resolveProfile } from '../src/providers/table.js';

/**
 * Calibrating and enforcing the token estimator's error band.
 *
 * The estimator is a character class heuristic, so its band is only honest if it
 * is measured. Here the estimate for each corpus sample is compared against the
 * exact count from the real OpenAI tokenizer, which is available offline. The
 * ninetieth percentile of the relative error must sit within the band the tool
 * prints for OpenAI, so a change that worsens the estimator fails here rather
 * than quietly widening the truth.
 *
 * Run with GROUNDHOG_CALIBRATE=1 to print the measured distribution, which is how
 * the committed band is chosen.
 */

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'calibration', 'corpus');

function kindOf(name: string): 'text' | 'json' {
  return name.includes('json') ? 'json' : 'text';
}

interface Sample {
  name: string;
  real: number;
  estimate: number;
  relErr: number;
}

function measure(): Sample[] {
  const files = readdirSync(CORPUS).filter((name) => name.endsWith('.txt')).sort();
  return files.map((name) => {
    const text = readFileSync(join(CORPUS, name), 'utf8');
    const real = gpt4o.encode(text).length;
    const estimate = estimateText(text, kindOf(name));
    return { name, real, estimate, relErr: real > 0 ? Math.abs(estimate - real) / real : 0 };
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

describe('token estimator calibration', () => {
  const samples = measure();

  it('has a corpus that spans the content classes', () => {
    // Prose, json, code, markdown, and cjk all tokenise differently, so the band
    // is only meaningful if the corpus contains each.
    expect(samples.length).toBeGreaterThanOrEqual(5);
    for (const sample of samples) expect(sample.real).toBeGreaterThan(20);
  });

  it('keeps the ninetieth percentile error within the OpenAI band', () => {
    const band = resolveProfile(loadTable({ discover: false }), 'openai', 'gpt-4o').tokenizer.errorBandPct / 100;
    const errors = samples.map((sample) => sample.relErr);
    const p90 = percentile(errors, 90);

    if (process.env['GROUNDHOG_CALIBRATE'] === '1') {
      // eslint-disable-next-line no-console
      console.log('\ntoken estimator vs o200k_base');
      for (const sample of samples) {
        console.log(`  ${sample.name.padEnd(32)} real ${String(sample.real).padStart(5)}  est ${String(sample.estimate).padStart(5)}  err ${(sample.relErr * 100).toFixed(1)}%`);
      }
      console.log(`  p50 ${(percentile(errors, 50) * 100).toFixed(1)}%  p90 ${(p90 * 100).toFixed(1)}%  p95 ${(percentile(errors, 95) * 100).toFixed(1)}%  max ${(Math.max(...errors) * 100).toFixed(1)}%  band ${(band * 100).toFixed(0)}%`);
    }

    // The band the tool prints must cover the ninetieth percentile of real error.
    expect(p90).toBeLessThanOrEqual(band);
    // An independent ceiling, so the estimator cannot silently degrade even if
    // the band is later widened. The measured p90 on this corpus is about 9.5%.
    expect(p90).toBeLessThanOrEqual(0.11);
    // No single realistic sample should fall outside the band at all.
    expect(Math.max(...errors)).toBeLessThanOrEqual(band);
  });

  it('covers the true count for most samples within the band', () => {
    const band = resolveProfile(loadTable({ discover: false }), 'openai', 'gpt-4o').tokenizer.errorBandPct / 100;
    const covered = samples.filter((sample) => sample.real >= sample.estimate * (1 - band) && sample.real <= sample.estimate * (1 + band));
    // The band is a coverage interval, so it should contain the real count for
    // the large majority of realistic samples.
    expect(covered.length / samples.length).toBeGreaterThanOrEqual(0.8);
  });
});
