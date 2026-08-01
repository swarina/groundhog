import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCapturedStability } from '../src/engine/stability.js';
import { adapterFor } from '../src/providers/adapters/index.js';
import { loadTable, resolveProfile } from '../src/providers/table.js';
import { renderStabilityReport } from '../src/report/stability.js';
import type { CanonicalRequest } from '../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The golden here is driven by captured requests rather than a live builder, so
 * the input is fixed bytes and the output is fully deterministic. A builder that
 * reads the clock could not pin an exact diff.
 */
function canonical(systemText: string, query: string): CanonicalRequest {
  return adapterFor('anthropic').parse(
    {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: query }],
    },
    { model: 'claude-sonnet-4-5', fidelity: 'wire' },
  );
}

const stable = 'You are a support agent. Answer only from the knowledge base provided below. '.repeat(90);
const profile = resolveProfile(loadTable({ discover: false }), 'anthropic', 'claude-sonnet-4-5');

describe('stability output', () => {
  const requests = [
    canonical(stable + ' Session id: 3f9a2c11', 'where is my order'),
    canonical(stable + ' Session id: 8b1d4e07', 'reset my password'),
  ];
  const report = checkCapturedStability(requests, profile, 'claude-sonnet-4-5');
  const output = renderStabilityReport(report, { color: false, width: 80 });

  it('matches the pinned output', () => {
    const goldenPath = join(HERE, 'golden', 'stability-session-id.txt');
    if (process.env['GROUNDHOG_UPDATE_GOLDEN'] === '1') {
      mkdirSync(join(HERE, 'golden'), { recursive: true });
      writeFileSync(goldenPath, output);
    }
    expect(existsSync(goldenPath)).toBe(true);
    expect(output).toBe(readFileSync(goldenPath, 'utf8'));
  });

  it('stays inside the wrap width and uses no decorative characters', () => {
    for (const line of output.split('\n')) expect(line.length).toBeLessThanOrEqual(84);
    expect(output).not.toMatch(/[─│┌┐└┘]/);
    expect(output).not.toMatch(/[–—]/);
  });

  it('shows the session id changing in the diff', () => {
    expect(output).toContain('3f9a2c11');
    expect(output).toContain('8b1d4e07');
  });
});
