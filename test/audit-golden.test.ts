import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decompose } from '../src/audit/decompose.js';
import { renderAuditResult } from '../src/report/audit.js';
import { loadTable, resolveProfile } from '../src/providers/table.js';
import type { AuditRecord, NormalisedUsage } from '../src/audit/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const profile = resolveProfile(loadTable({ discover: false }), 'anthropic', 'claude-sonnet-4-6');

/**
 * The audit render is pinned from a fixed synthetic log. The decomposition and
 * the renderer read only the record timestamps, never the wall clock, so the
 * output is deterministic and a change to it shows up as a diff to review.
 */
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

/** A log that exercises every bucket: hits, a cold write, an expiry, a reconciliation miss, and fragments. */
function fixedLog(): AuditRecord[] {
  const records: AuditRecord[] = [rec(0, 'stable', WRITE)];
  for (let i = 1; i <= 20; i += 1) records.push(rec(i * 10, 'stable', HIT));
  records.push(rec(600, 'stable', WRITE)); // gap beyond the 5 minute window
  for (let i = 1; i <= 5; i += 1) records.push(rec(600 + i * 10, 'stable', HIT));
  records.push(rec(680, 'stable', MISS)); // matches recently, but usage says no hit
  for (let i = 0; i < 8; i += 1) records.push(rec(700 + i * 5, `fragment-${i}`, WRITE));
  return records;
}

describe('audit output', () => {
  const result = decompose(fixedLog(), profile);
  const output = renderAuditResult(result, { color: false, width: 80 });

  it('matches the pinned output', () => {
    const goldenPath = join(HERE, 'golden', 'audit-mixed.txt');
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

  it('leads with the observed rate, the reachable rate, and the gap', () => {
    expect(output).toContain('observed');
    expect(output).toContain('achievable');
    expect(output).toContain('recoverable');
    expect(output).toContain('where it goes');
  });
});
