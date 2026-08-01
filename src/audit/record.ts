import { prefixHash } from '../core/canonical.js';
import { comparablePrefix } from '../core/span.js';
import { adapterFor, detectProvider } from '../providers/adapters/index.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';
import { normaliseUsage } from './ingest.js';
import type { AuditRecord } from './types.js';

/**
 * Building one log record from a request and its response.
 *
 * This is the bridge a log producer needs. It takes the request body an
 * application sent and the usage the provider returned, and produces the record
 * the audit reads: a timestamp, the hash of the cacheable prefix, and the
 * normalised usage. No prompt content is kept, so a log built from this carries
 * nothing sensitive.
 *
 * The prefix is hashed at the cache boundary rather than over the whole request,
 * so two turns of one conversation that share a system prompt group together
 * even though their final messages differ.
 */

export interface RecordInput {
  /** The request body the application sent. */
  body: unknown;
  /** The usage object from the response, in the provider's own shape. */
  usage: unknown;
  /** ISO timestamp. Supplied by the caller, since this module stays pure. */
  ts: string;
  provider?: string;
  model?: string;
  /** Request url, when known, which makes provider detection exact. */
  url?: string;
  tags?: Record<string, string>;
}

export function buildAuditRecord(input: RecordInput, options: LoadOptions = {}): AuditRecord {
  const loaded = loadTable(options);
  const provider = input.provider ?? detectProvider(loaded.table, input.body, input.url).provider;
  const record = (input.body ?? {}) as Record<string, unknown>;
  const model = input.model ?? (typeof record['model'] === 'string' ? record['model'] : '');
  if (!model) throw new Error('An audit record needs a model, and the request body had none. Pass model.');

  const request = adapterFor(provider).parse(input.body, { model, fidelity: 'wire' });
  const profile = resolveProfile(loaded, provider, model);
  const prefix = comparablePrefix(request, profile);

  return {
    ts: input.ts,
    provider,
    model,
    prefixHash: prefixHash(prefix),
    usage: normaliseUsage(input.usage, profile.usageFields),
    ...(input.tags ? { tags: input.tags } : {}),
  };
}

/** One record as a single ndjson line, ready to append to a log. */
export function auditRecordLine(input: RecordInput, options: LoadOptions = {}): string {
  return JSON.stringify(buildAuditRecord(input, options));
}
