import type { ProviderId } from '../types.js';

/**
 * One logged request, normalised.
 *
 * A log is produced in production, where the response carries the usage that
 * says what actually hit the cache. The audit needs only a few fields per
 * request: when it happened, which prefix it carried, and how its tokens were
 * billed. No prompt content is required, so a log can be kept without recording
 * anything sensitive.
 */
export interface AuditRecord {
  /** ISO 8601 timestamp of the request. */
  ts: string;
  provider: ProviderId;
  model: string;
  /** Hash of the cacheable prefix, which is how requests are grouped. */
  prefixHash: string;
  usage: NormalisedUsage;
  /** Optional labels, hashed if they carry anything identifying. */
  tags?: Record<string, string>;
}

/**
 * Token accounting reduced to three disjoint parts.
 *
 * Providers report usage differently, so it is normalised on the way in. Every
 * prompt token is exactly one of: served from cache, written to cache on a
 * miss, or processed without touching the cache.
 */
export interface NormalisedUsage {
  cacheRead: number;
  cacheWrite: number;
  uncached: number;
}

export function promptTokens(usage: NormalisedUsage): number {
  return usage.cacheRead + usage.cacheWrite + usage.uncached;
}

/** True when any of this request's prompt was served from cache. */
export function wasHit(usage: NormalisedUsage): boolean {
  return usage.cacheRead > 0;
}
