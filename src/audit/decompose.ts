import type { ProviderProfile } from '../types.js';
import { promptTokens, wasHit, type AuditRecord } from './types.js';

/**
 * Splitting the cache loss into causes, against a ceiling that is actually
 * reachable.
 *
 * Raw hit rate is a misleading target. Even a perfect application pays one cache
 * write per distinct prefix per time to live window, so chasing a hundred
 * percent is chasing something that does not exist. The useful question is how
 * far the observed rate sits below what this traffic could reach, and which
 * fixable cause accounts for the gap.
 *
 * Every request that is not a hit is placed in exactly one bucket, computed
 * rather than guessed:
 *
 *   irreducible   the first request for a prefix that does reuse, per window
 *   fragment      a prefix that appears once and never reuses
 *   ttl-expiry    a prefix seen before, but longer ago than the window allows
 *   reconciled    a prefix that should have hit but the usage says it did not
 *
 * The last bucket is the honest one. When our model says a request should have
 * hit and the provider says it did not, we were wrong about something outside
 * the prefix, usually routing or scope, and we say so rather than reporting a
 * rate we invented.
 */

export type LossBucket = 'irreducible' | 'fragment' | 'ttl-expiry' | 'reconciled';

export interface BucketSummary {
  bucket: LossBucket;
  requests: number;
  /** Tokens billed at the full rate that this bucket accounts for. */
  uncachedTokens: number;
  costUsd: number | null;
}

export interface PrefixSummary {
  prefixHash: string;
  requests: number;
  /** Fraction of the whole log this prefix accounts for. */
  share: number;
  reused: boolean;
}

export interface AuditResult {
  provider: string;
  model: string;
  totalRequests: number;
  window: { id: string; seconds: number } | null;
  /** Realised hit rate, from the usage fields, count based. */
  observedHitRate: number;
  /** The best hit rate this traffic could reach given its shape and the window. */
  achievableCeiling: number;
  buckets: BucketSummary[];
  hits: number;
  /** Distinct prefixes, and how concentrated the traffic is across them. */
  distinctPrefixes: number;
  topPrefixes: PrefixSummary[];
  priceKnown: boolean;
  /** Requests whose provider was not the audited one, skipped and counted. */
  skippedOtherProvider: number;
  timeSpanSeconds: number;
}

interface Classified {
  record: AuditRecord;
  bucket: LossBucket | 'hit';
}

function ttlSeconds(profile: ProviderProfile): { id: string; seconds: number } | null {
  const def = profile.caching.ttls.find((ttl) => ttl.isDefault) ?? profile.caching.ttls[0];
  return def ? { id: def.id, seconds: def.seconds } : null;
}

function classify(records: AuditRecord[], windowSeconds: number | null): Classified[] {
  const sorted = [...records].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // Total occurrences per prefix decides whether an unmatched request is a
  // fragment (only ever seen once) or a genuine cold start (reused later).
  const totalCount = new Map<string, number>();
  for (const record of sorted) totalCount.set(record.prefixHash, (totalCount.get(record.prefixHash) ?? 0) + 1);

  const lastSeen = new Map<string, number>();
  const out: Classified[] = [];

  for (const record of sorted) {
    const now = Date.parse(record.ts);
    const previous = lastSeen.get(record.prefixHash);
    lastSeen.set(record.prefixHash, now);

    const withinWindow =
      previous != null && (windowSeconds == null || (now - previous) / 1000 <= windowSeconds);

    if (withinWindow) {
      // Our model says this should have hit. The usage decides whether it did.
      out.push({ record, bucket: wasHit(record.usage) ? 'hit' : 'reconciled' });
      continue;
    }

    if (previous != null) {
      out.push({ record, bucket: 'ttl-expiry' });
    } else if ((totalCount.get(record.prefixHash) ?? 0) > 1) {
      out.push({ record, bucket: 'irreducible' });
    } else {
      out.push({ record, bucket: 'fragment' });
    }
  }

  return out;
}

function uncachedTokensOf(record: AuditRecord): number {
  // On a miss the whole prompt is billed at the uncached or write rate. The
  // recoverable amount is what a hit would have served from cache instead.
  return record.usage.cacheWrite + record.usage.uncached;
}

export function decompose(records: AuditRecord[], profile: ProviderProfile): AuditResult {
  const mine = records.filter((record) => record.provider === profile.id && record.model === profile.model.id);
  const skippedOtherProvider = records.length - mine.length;

  const window = ttlSeconds(profile);
  const classified = classify(mine, window ? window.seconds : null);

  const byBucket = new Map<LossBucket, { requests: number; uncachedTokens: number }>();
  let hits = 0;
  for (const item of classified) {
    if (item.bucket === 'hit') {
      hits += 1;
      continue;
    }
    const entry = byBucket.get(item.bucket) ?? { requests: 0, uncachedTokens: 0 };
    entry.requests += 1;
    entry.uncachedTokens += uncachedTokensOf(item.record);
    byBucket.set(item.bucket, entry);
  }

  const price = profile.model.price.value;
  const cost = (tokens: number): number | null =>
    price ? (tokens / 1_000_000) * (price.inputPer1M - price.cachedReadPer1M) : null;

  const order: LossBucket[] = ['fragment', 'ttl-expiry', 'reconciled', 'irreducible'];
  const buckets: BucketSummary[] = order
    .map((bucket) => {
      const entry = byBucket.get(bucket) ?? { requests: 0, uncachedTokens: 0 };
      return { bucket, requests: entry.requests, uncachedTokens: entry.uncachedTokens, costUsd: cost(entry.uncachedTokens) };
    })
    .filter((summary) => summary.requests > 0);

  const total = mine.length;
  const irreducible = byBucket.get('irreducible')?.requests ?? 0;
  // The ceiling assumes fragmentation, expiry, and routing are all fixed. Even
  // then a cold write is owed for each reused prefix, and if nothing currently
  // reuses, unifying the fragments would still owe one write for the prefix they
  // collapse into. So the floor of necessary writes is one whenever there is any
  // recoverable loss to fix.
  const recoverableLoss = total - hits - irreducible;
  const necessaryWrites = irreducible > 0 ? irreducible : recoverableLoss > 0 ? 1 : 0;

  const counts = new Map<string, number>();
  for (const record of mine) counts.set(record.prefixHash, (counts.get(record.prefixHash) ?? 0) + 1);
  const topPrefixes: PrefixSummary[] = [...counts.entries()]
    .map(([prefixHash, requests]) => ({ prefixHash, requests, share: total > 0 ? requests / total : 0, reused: requests > 1 }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);

  const times = mine.map((record) => Date.parse(record.ts)).filter((value) => !Number.isNaN(value));
  const timeSpanSeconds = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;

  return {
    provider: profile.id,
    model: profile.model.id,
    totalRequests: total,
    window,
    observedHitRate: total > 0 ? hits / total : 0,
    achievableCeiling: total > 0 ? 1 - necessaryWrites / total : 0,
    buckets,
    hits,
    distinctPrefixes: counts.size,
    topPrefixes,
    priceKnown: price != null,
    skippedOtherProvider,
    timeSpanSeconds,
  };
}
