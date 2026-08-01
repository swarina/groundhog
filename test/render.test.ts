import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectRequest } from '../src/engine/inspect.js';
import { renderReport } from '../src/report/render.js';
import { CATALOGUE, explain } from '../src/report/catalogue.js';
import { expandFiller } from './fixtures/filler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-08-01T00:00:00Z');

const CASES: Array<{ name: string; model: string }> = [
  { name: 'anthropic-no-boundary', model: 'claude-opus-5' },
  { name: 'anthropic-below-minimum', model: 'claude-opus-5' },
  { name: 'anthropic-qualifies', model: 'claude-sonnet-4-5' },
  { name: 'openai-below-floor', model: 'gpt-4o' },
  { name: 'openai-compatible-unknown', model: 'llama-3.3-70b-instruct' },
];

function render(name: string, model: string): string {
  const body = expandFiller(JSON.parse(readFileSync(join(HERE, 'fixtures', 'static', name, 'request.json'), 'utf8')));
  const report = inspectRequest(body, { model, now: NOW, discover: false });
  return renderReport(report, { color: false, width: 80 });
}

describe('terminal output', () => {
  for (const testCase of CASES) {
    describe(testCase.name, () => {
      const output = render(testCase.name, testCase.model);

      it('matches the pinned output', () => {
        const goldenPath = join(HERE, 'golden', `${testCase.name}.txt`);
        // Regenerate with GROUNDHOG_UPDATE_GOLDEN=1 and read the diff before
        // committing it. Output is a deliberate part of the product, so a
        // change to it should be reviewed rather than absorbed.
        if (process.env['GROUNDHOG_UPDATE_GOLDEN'] === '1') {
          mkdirSync(join(HERE, 'golden'), { recursive: true });
          writeFileSync(goldenPath, output);
        }
        expect(existsSync(goldenPath), `missing golden file ${goldenPath}`).toBe(true);
        expect(output).toBe(readFileSync(goldenPath, 'utf8'));
      });

      it('stays inside the wrap width', () => {
        for (const line of output.split('\n')) {
          expect(line.length, `line too long: ${line}`).toBeLessThanOrEqual(84);
        }
      });

      it('uses no decorative characters', () => {
        expect(output).not.toMatch(/[─│┌┐└┘├┤┬┴┼═║╔╗╚╝▀▄█]/);
        expect(output).not.toMatch(/[–—]/);
      });

      it('emits no colour codes when colour is off', () => {
        expect(output).not.toMatch(/\[/);
      });

      it('always says how old the provider data is', () => {
        expect(output).toMatch(/provider data verified \d{4}-\d{2}-\d{2}/);
      });

      it('never claims stability, which one request cannot show', () => {
        expect(output).toContain('one request cannot answer');
      });
    });
  }
});

describe('finding catalogue', () => {
  it('has an entry for every code the detectors can emit', () => {
    const emitted = new Set<string>();
    for (const testCase of CASES) {
      const body = expandFiller(
        JSON.parse(readFileSync(join(HERE, 'fixtures', 'static', testCase.name, 'request.json'), 'utf8')),
      );
      const report = inspectRequest(body, { model: testCase.model, now: NOW, discover: false });
      for (const finding of report.findings) emitted.add(finding.code);
      for (const skip of report.skipped) emitted.add(skip.code);
    }
    for (const code of emitted) {
      expect(CATALOGUE[code], `no catalogue entry for ${code}`).toBeDefined();
    }
  });

  it('gives every entry a cause and a fix', () => {
    for (const entry of Object.values(CATALOGUE)) {
      expect(entry.what.length).toBeGreaterThan(30);
      expect(entry.why.length).toBeGreaterThan(30);
      expect(entry.fix.length).toBeGreaterThan(30);
      expect(entry.detects.length).toBeGreaterThan(0);
    }
  });

  it('wraps its output like every other surface', () => {
    for (const code of Object.keys(CATALOGUE)) {
      for (const line of explain(code).split('\n')) {
        expect(line.length, `line too long in ${code}: ${line}`).toBeLessThanOrEqual(80);
      }
    }
  });

  it('says what it does not know instead of guessing', () => {
    expect(explain('GH999')).toContain('Unknown finding code');
  });
});
