import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
    const specifier = match[1];
    if (specifier) out.push(specifier);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({ path: file, rel: relative(SRC, file), imports: importsOf(file) }));

/**
 * These are the rules that keep a provider from becoming a special case. They
 * are asserted rather than agreed, because a boundary nobody checks is a
 * boundary that erodes on a busy afternoon.
 */
describe('module boundaries', () => {
  it('finds the source tree', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('keeps the provider layer out of core', () => {
    for (const file of FILES) {
      if (!file.rel.startsWith('core/')) continue;
      for (const specifier of file.imports) {
        expect(specifier, `${file.rel} imports ${specifier}`).not.toMatch(/providers/);
      }
    }
  });

  it('keeps the provider table loader out of the classifier', () => {
    for (const file of FILES) {
      if (!file.rel.startsWith('classify/')) continue;
      for (const specifier of file.imports) {
        expect(specifier, `${file.rel} imports ${specifier}`).not.toMatch(/providers/);
      }
    }
  });

  it('keeps decisions out of the renderer', () => {
    // The renderer may format a severity. It may not decide one.
    for (const file of FILES) {
      if (!file.rel.startsWith('report/')) continue;
      for (const specifier of file.imports) {
        expect(specifier, `${file.rel} imports ${specifier}`).not.toMatch(/classify|providers|engine/);
      }
    }
  });

  it('never names a provider inside core or the classifier', () => {
    const names = /\b(anthropic|openai|gemini|claude|gpt-)\b/i;
    for (const file of FILES) {
      if (!file.rel.startsWith('core/') && !file.rel.startsWith('classify/')) continue;
      const text = readFileSync(file.path, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, `${file.rel} names a provider`).not.toMatch(names);
    }
  });
});

describe('writing rules', () => {
  it('uses no em dashes or en dashes anywhere in the source', () => {
    for (const file of FILES) {
      const text = readFileSync(file.path, 'utf8');
      expect(text, `${file.rel} contains a dash character that is not a hyphen`).not.toMatch(/[–—]/);
    }
  });

  it('uses no em dashes or en dashes in the provider data', () => {
    const text = readFileSync(join(ROOT, 'data', 'providers.json'), 'utf8');
    expect(text).not.toMatch(/[–—]/);
  });
});
