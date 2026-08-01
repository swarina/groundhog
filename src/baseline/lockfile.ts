import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prefixHash } from '../core/canonical.js';
import { comparablePrefix } from '../core/span.js';
import { adapterFor, detectProvider } from '../providers/adapters/index.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';
import { estimateBlocks } from '../tokens/estimate.js';

/**
 * The committed record of what a prompt's cacheable prefix hashes to.
 *
 * A prompt edit that ships on a deploy invalidates every cached prefix across
 * the fleet at once. It costs real money for as long as the cache refills, and
 * nothing reports it, because each request still succeeds. A hash committed
 * beside the code turns that into a one line diff in review: the number changed,
 * so the cache will cold start.
 */

export const DEFAULT_LOCKFILE = '.groundhog/baseline.json';

export interface BaselineEntry {
  id: string;
  provider: string;
  model: string;
  prefixHash: string;
  tokens: number;
  recordedAt: string;
}

export interface Lockfile {
  version: 1;
  entries: BaselineEntry[];
}

export interface ComputeOptions extends LoadOptions {
  provider?: string;
  model?: string;
}

/** The cacheable prefix hash and token estimate for one request body. */
export function computePrefix(body: unknown, options: ComputeOptions = {}): { provider: string; model: string; prefixHash: string; tokens: number } {
  const loaded = loadTable(options);
  const provider = options.provider ?? detectProvider(loaded.table, body).provider;
  const record = (body ?? {}) as Record<string, unknown>;
  const model = options.model ?? (typeof record['model'] === 'string' ? record['model'] : '');
  if (!model) throw new Error('A baseline needs a model, and the request body had none. Pass model.');

  const request = adapterFor(provider).parse(body, { model, fidelity: 'builder' });
  const profile = resolveProfile(loaded, provider, model);
  const prefix = comparablePrefix(request, profile);
  return { provider, model, prefixHash: prefixHash(prefix), tokens: estimateBlocks(prefix, profile.tokenizer).value };
}

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Lockfile;
  return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

export function writeLockfile(path: string, lockfile: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  // Entries sorted by id so the file is stable and diffs are minimal.
  const entries = [...lockfile.entries].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(path, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
}

/** Adds or replaces an entry, returning the updated lockfile. */
export function upsertEntry(lockfile: Lockfile, entry: BaselineEntry): Lockfile {
  const entries = lockfile.entries.filter((existing) => existing.id !== entry.id);
  entries.push(entry);
  return { version: 1, entries };
}

export interface DriftResult {
  id: string;
  changed: boolean;
  before: string;
  after: string;
  tokensBefore: number;
  tokensAfter: number;
}

/** Compares a freshly computed prefix against a stored entry. */
export function compareEntry(stored: BaselineEntry, current: { prefixHash: string; tokens: number }): DriftResult {
  return {
    id: stored.id,
    changed: stored.prefixHash !== current.prefixHash,
    before: stored.prefixHash,
    after: current.prefixHash,
    tokensBefore: stored.tokens,
    tokensAfter: current.tokens,
  };
}
