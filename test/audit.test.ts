import { describe, expect, it } from 'vitest';
import { decompose } from '../src/audit/decompose.js';
import { normaliseUsage, parseLog, LogFormatError } from '../src/audit/ingest.js';
import { auditRecords } from '../src/engine/audit.js';
import { renderAuditResult } from '../src/report/audit.js';
import { loadTable, resolveProfile } from '../src/providers/table.js';
import type { AuditRecord, NormalisedUsage } from '../src/audit/types.js';

const loaded = loadTable({ discover: false });
const profile = resolveProfile(loaded, 'anthropic', 'claude-sonnet-4-6');

const T0 = Date.parse('2026-08-02T09:00:00Z');
function at(offsetSeconds: number): string {
  return new Date(T0 + offsetSeconds * 1000).toISOString();
}

const HIT: NormalisedUsage = { cacheRead: 2000, cacheWrite: 0, uncached: 100 };
const WRITE: NormalisedUsage = { cacheRead: 0, cacheWrite: 2000, uncached: 100 };
const MISS: NormalisedUsage = { cacheRead: 0, cacheWrite: 0, uncached: 2100 };

function rec(offsetSeconds: number, prefixHash: string, usage: NormalisedUsage): AuditRecord {
  return { ts: at(offsetSeconds), provider: 'anthropic', model: 'claude-sonnet-4-6', prefixHash, usage };
}

describe('loss decomposition', () => {
  it('counts a realised hit rate from the usage', () => {
    const result = decompose([rec(0, 'P', WRITE), rec(10, 'P', HIT), rec(20, 'P', HIT)], profile);
    expect(result.observedHitRate).toBeCloseTo(2 / 3, 5);
  });

  it('treats the first request for a reused prefix as an irreducible write', () => {
    const result = decompose([rec(0, 'P', WRITE), rec(10, 'P', HIT)], profile);
    expect(result.buckets.find((bucket) => bucket.bucket === 'irreducible')?.requests).toBe(1);
    // Ceiling excludes only that one irreducible write.
    expect(result.achievableCeiling).toBeCloseTo(1 - 1 / 2, 5);
  });

  it('calls a prefix that appears once fragmentation', () => {
    const result = decompose([rec(0, 'A', WRITE), rec(10, 'B', WRITE), rec(20, 'C', WRITE)], profile);
    expect(result.buckets.find((bucket) => bucket.bucket === 'fragment')?.requests).toBe(3);
    // If the three fragments were unified into one prefix, the first request
    // would still be a write and the other two would hit, so two of three.
    expect(result.achievableCeiling).toBeCloseTo(2 / 3, 5);
  });

  it('calls a gap longer than the window a time to live expiry', () => {
    // Same prefix twice, 10 minutes apart, against a 5 minute window.
    const result = decompose([rec(0, 'P', WRITE), rec(600, 'P', WRITE)], profile);
    expect(result.buckets.find((bucket) => bucket.bucket === 'ttl-expiry')?.requests).toBe(1);
  });

  it('reconciles a matching prefix that the usage says did not hit', () => {
    // The prefix was seen a moment ago, so our model expects a hit. The usage
    // shows none, so the miss is outside the prefix, in routing or scope.
    const result = decompose([rec(0, 'P', WRITE), rec(10, 'P', MISS)], profile);
    expect(result.buckets.find((bucket) => bucket.bucket === 'reconciled')?.requests).toBe(1);
    expect(result.observedHitRate).toBe(0);
  });

  it('places every non hit in exactly one bucket', () => {
    const records = [
      rec(0, 'P', WRITE),
      rec(10, 'P', HIT),
      rec(600, 'P', WRITE),
      rec(610, 'P', MISS),
      rec(700, 'Q', WRITE),
    ];
    const result = decompose(records, profile);
    const bucketed = result.buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    expect(bucketed + result.hits).toBe(records.length);
  });

  it('reports cost only when the model has prices', () => {
    const withPrice = decompose([rec(0, 'A', WRITE), rec(10, 'B', WRITE)], profile);
    expect(withPrice.priceKnown).toBe(true);
    expect(withPrice.buckets[0]?.costUsd).toBeGreaterThan(0);

    const noPrice = resolveProfile(loaded, 'anthropic', 'claude-opus-5');
    const nameless = decompose(
      [
        { ts: at(0), provider: 'anthropic', model: 'claude-opus-5', prefixHash: 'A', usage: WRITE },
        { ts: at(10), provider: 'anthropic', model: 'claude-opus-5', prefixHash: 'B', usage: WRITE },
      ],
      noPrice,
    );
    expect(nameless.priceKnown).toBe(false);
    expect(nameless.buckets[0]?.costUsd).toBeNull();
  });

  it('ranks the busiest prefixes', () => {
    const records = [rec(0, 'P', WRITE), rec(10, 'P', HIT), rec(20, 'P', HIT), rec(30, 'Q', WRITE)];
    const result = decompose(records, profile);
    expect(result.topPrefixes[0]?.prefixHash).toBe('P');
    expect(result.topPrefixes[0]?.share).toBeCloseTo(3 / 4, 5);
  });
});

describe('usage normalisation', () => {
  it('reads anthropic usage, where input excludes the cached tokens', () => {
    const usage = normaliseUsage(
      { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
      profile.usageFields,
    );
    expect(usage).toEqual({ cacheRead: 2000, cacheWrite: 0, uncached: 100 });
  });

  it('reads openai usage, where prompt tokens include the cached ones', () => {
    const openai = resolveProfile(loaded, 'openai', 'gpt-4o');
    const usage = normaliseUsage(
      { prompt_tokens: 2100, prompt_tokens_details: { cached_tokens: 2000 } },
      openai.usageFields,
    );
    // Uncached is the remainder once the cached tokens are removed.
    expect(usage).toEqual({ cacheRead: 2000, cacheWrite: 0, uncached: 100 });
  });
});

describe('ingest', () => {
  const context = { profileFor: (p: string, m: string) => resolveProfile(loaded, p, m) };

  it('reads records that are already normalised', () => {
    const line = JSON.stringify({ ts: at(0), provider: 'anthropic', model: 'claude-sonnet-4-6', prefixHash: 'P', usage: HIT });
    expect(parseLog(line, context)).toHaveLength(1);
  });

  it('normalises records that carry raw provider usage', () => {
    const line = JSON.stringify({
      ts: at(0),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      prefixHash: 'P',
      usage: { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    });
    const records = parseLog(line, context);
    expect(records[0]?.usage.cacheRead).toBe(2000);
  });

  it('names the line and the problem on a bad record', () => {
    const text = ['{"ts":"' + at(0) + '","provider":"anthropic","model":"claude-sonnet-4-6","prefixHash":"P","usage":{"cacheRead":1,"cacheWrite":0,"uncached":0}}', '{"provider":"anthropic"}'].join('\n');
    expect(() => parseLog(text, context)).toThrow(LogFormatError);
    try {
      parseLog(text, context);
    } catch (error) {
      expect((error as Error).message).toContain('line 2');
    }
  });
});

describe('grouping and rendering', () => {
  it('audits each model in a log separately', () => {
    const records: AuditRecord[] = [
      rec(0, 'P', WRITE),
      rec(10, 'P', HIT),
      { ts: at(20), provider: 'openai', model: 'gpt-4o', prefixHash: 'Q', usage: HIT },
    ];
    const results = auditRecords(records, { discover: false });
    expect(results).toHaveLength(2);
    expect(results[0]?.totalRequests).toBe(2);
  });

  it('renders without decorative characters and inside the width', () => {
    const result = decompose([rec(0, 'P', WRITE), rec(10, 'P', HIT), rec(20, 'A', WRITE)], profile);
    const output = renderAuditResult(result, { color: false, width: 80 });
    expect(output).toContain('observed');
    expect(output).toContain('achievable');
    for (const line of output.split('\n')) expect(line.length).toBeLessThanOrEqual(84);
    expect(output).not.toMatch(/[─│┌┐└┘]/);
    expect(output).not.toMatch(/[–—]/);
  });
});
