import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectRequest } from '../src/engine/inspect.js';
import type { Report } from '../src/types.js';
import { expandFiller } from './fixtures/filler.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'static');

/** Pinned so staleness findings and any dated output stay deterministic. */
const NOW = new Date('2026-08-01T00:00:00Z');

interface Expected {
  note?: string;
  model: string;
  provider?: string;
  ok: boolean;
  certain: boolean;
  codes: string[];
  notCodes: string[];
  skipped?: string[];
}

function load(name: string): { body: unknown; expected: Expected } {
  const dir = join(FIXTURES, name);
  const body = expandFiller(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')));
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Expected;
  return { body, expected };
}

function run(body: unknown, expected: Expected): Report {
  return inspectRequest(body, {
    model: expected.model,
    ...(expected.provider ? { provider: expected.provider } : {}),
    now: NOW,
    // Only the bundled table, so a developer's own override file cannot change
    // what the suite asserts.
    discover: false,
  });
}

const cases = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('static detectors', () => {
  it('finds fixture cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    describe(name, () => {
      const { body, expected } = load(name);
      const report = run(body, expected);
      const codes = report.findings.map((finding) => finding.code);

      it('reports every expected code', () => {
        for (const code of expected.codes) expect(codes).toContain(code);
      });

      it('reports none of the codes it must not', () => {
        for (const code of expected.notCodes) expect(codes).not.toContain(code);
      });

      it('reaches the expected verdict', () => {
        expect(report.ok).toBe(expected.ok);
        expect(report.certain).toBe(expected.certain);
      });

      if (expected.skipped) {
        it('names every check it could not run', () => {
          const skipped = report.skipped.map((entry) => entry.code);
          for (const code of expected.skipped ?? []) expect(skipped).toContain(code);
        });
      }

      it('gives every finding a fix', () => {
        for (const finding of report.findings) {
          expect(finding.fix.length).toBeGreaterThan(20);
          expect(finding.detail.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe('the gate that matters', () => {
  /**
   * A false clean is the one result this tool must never produce. Every fixture
   * that carries a problem has to surface it, and no amount of confidence
   * qualification is allowed to turn a failure into a pass.
   */
  it('never reports clean for a fixture that expects a failure', () => {
    for (const name of cases) {
      const { body, expected } = load(name);
      if (expected.ok) continue;
      const report = run(body, expected);
      expect(report.ok, `${name} expects a failure and reported clean`).toBe(false);
      expect(report.findings.some((finding) => finding.severity === 'fail')).toBe(true);
    }
  });

  it('never marks an uncertain finding as anything other than uncertain', () => {
    for (const name of cases) {
      const { body, expected } = load(name);
      const report = run(body, expected);
      for (const finding of report.findings) {
        if (finding.uncertain) expect(report.certain).toBe(false);
      }
    }
  });
});
