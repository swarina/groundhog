import { readFileSync } from 'node:fs';
import type { ProviderProfile, UsageFields } from '../types.js';
import type { AuditRecord, NormalisedUsage } from './types.js';

/**
 * Reading a log and normalising the usage in it.
 *
 * A record can arrive already normalised, which is what a groundhog producer
 * writes, or carrying a raw provider usage object, which is what a hand rolled
 * logger is likely to have. Both are accepted. Raw usage is normalised through
 * the provider table, so the audit downstream sees one shape regardless.
 */

export class LogFormatError extends Error {
  constructor(line: number, detail: string) {
    super(`Log record on line ${line} could not be read: ${detail}`);
    this.name = 'LogFormatError';
  }
}

function pluck(source: unknown, path: string): number {
  if (!path) return 0;
  // The table records paths relative to the response, prefixed with "usage.".
  // A log stores the usage object itself, so that prefix is dropped here.
  const relative = path.startsWith('usage.') ? path.slice('usage.'.length) : path;
  let current: unknown = source;
  for (const key of relative.split('.')) {
    if (current == null || typeof current !== 'object') return 0;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'number' ? current : 0;
}

/** Reduces a provider's raw usage object to the three disjoint parts. */
export function normaliseUsage(rawUsage: unknown, fields: UsageFields): NormalisedUsage {
  const cacheRead = pluck(rawUsage, fields.cacheRead);
  const cacheWrite = pluck(rawUsage, fields.cacheWrite);
  const input = pluck(rawUsage, fields.input);
  const uncached = fields.inputIncludesCached ? Math.max(0, input - cacheRead - cacheWrite) : input;
  return { cacheRead, cacheWrite, uncached };
}

function isNormalised(usage: unknown): usage is NormalisedUsage {
  return (
    usage != null &&
    typeof usage === 'object' &&
    typeof (usage as Record<string, unknown>)['uncached'] === 'number' &&
    typeof (usage as Record<string, unknown>)['cacheRead'] === 'number'
  );
}

export interface IngestContext {
  /** Resolves a profile for a provider and model, to normalise raw usage. */
  profileFor(provider: string, model: string): ProviderProfile;
}

function toRecord(value: unknown, line: number, context: IngestContext): AuditRecord {
  const record = (value ?? {}) as Record<string, unknown>;
  const ts = record['ts'];
  const provider = record['provider'];
  const model = record['model'];
  const prefixHash = record['prefixHash'] ?? record['prefix'];

  if (typeof ts !== 'string') throw new LogFormatError(line, 'missing an ISO timestamp in "ts"');
  if (typeof provider !== 'string') throw new LogFormatError(line, 'missing "provider"');
  if (typeof model !== 'string') throw new LogFormatError(line, 'missing "model"');
  if (typeof prefixHash !== 'string') throw new LogFormatError(line, 'missing "prefixHash"');

  const rawUsage = record['usage'];
  let usage: NormalisedUsage;
  if (isNormalised(rawUsage)) {
    usage = { cacheRead: rawUsage.cacheRead, cacheWrite: rawUsage.cacheWrite, uncached: rawUsage.uncached };
  } else if (rawUsage != null) {
    usage = normaliseUsage(rawUsage, context.profileFor(provider, model).usageFields);
  } else {
    throw new LogFormatError(line, 'missing "usage"');
  }

  return {
    ts,
    provider,
    model,
    prefixHash,
    usage,
    ...(record['tags'] && typeof record['tags'] === 'object' ? { tags: record['tags'] as Record<string, string> } : {}),
  };
}

export function parseLog(text: string, context: IngestContext): AuditRecord[] {
  const out: AuditRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] as string).trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new LogFormatError(i + 1, 'not valid json');
    }
    if (Array.isArray(parsed)) {
      parsed.forEach((entry) => out.push(toRecord(entry, i + 1, context)));
    } else {
      out.push(toRecord(parsed, i + 1, context));
    }
  }
  return out;
}

export function readLog(path: string, context: IngestContext): AuditRecord[] {
  return parseLog(readFileSync(path, 'utf8'), context);
}
