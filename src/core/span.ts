import type { Block, CanonicalRequest, ProviderProfile } from '../types.js';

/**
 * Works out which blocks are in the cacheable span, and says how it decided.
 *
 * There are two very different situations. When the provider requires explicit
 * boundaries, the span is whatever the request declares, and declaring nothing
 * means nothing is cached. When the provider caches automatically, no request
 * declares anything, and the span that actually gets cached is whatever this
 * request happens to share with the previous one. A single request cannot show
 * that, so the whole prefix is reported as the candidate and the basis says so
 * rather than implying a measurement that was not made.
 */

export interface SpanResolution {
  blocks: Block[];
  declaredMarkers: number;
  boundaryMode: 'explicit' | 'implicit' | 'unknown';
  /** Human readable account of how the span was chosen. Appears in output. */
  basis: string;
  /** True when the span is a candidate rather than a measured shared prefix. */
  isCandidate: boolean;
}

export function resolveSpan(request: CanonicalRequest, profile: ProviderProfile): SpanResolution {
  const markers = request.blocks.filter((block) => block.cacheMarker != null);
  const mode = profile.caching.mode;

  if (mode === 'explicit') {
    if (markers.length === 0) {
      return {
        blocks: [],
        declaredMarkers: 0,
        boundaryMode: 'explicit',
        basis: 'no cache boundary declared, so nothing in this request is cacheable',
        isCandidate: false,
      };
    }
    const last = markers[markers.length - 1];
    const end = last ? last.index : -1;
    return {
      blocks: request.blocks.filter((block) => block.index <= end),
      declaredMarkers: markers.length,
      boundaryMode: 'explicit',
      basis: `declared boundary at block ${end} of ${request.blocks.length}`,
      isCandidate: false,
    };
  }

  if (mode === 'implicit') {
    return {
      blocks: request.blocks,
      declaredMarkers: markers.length,
      boundaryMode: 'implicit',
      basis: 'provider caches the longest matching prefix, so the whole request is the candidate span',
      isCandidate: true,
    };
  }

  return {
    blocks: request.blocks,
    declaredMarkers: markers.length,
    boundaryMode: 'unknown',
    basis: 'caching behaviour for this endpoint is not known, so the whole request is shown without a verdict',
    isCandidate: true,
  };
}

/**
 * Tokens actually billed at the cached rate once the provider floor and
 * granularity are applied.
 *
 * A shared prefix is not the same as a cached prefix. When a provider caches in
 * steps above a floor, a span between two steps is billed at the lower step and
 * the remainder is charged in full. Returns null when either fact is unknown,
 * so the caller reports nothing rather than a number it cannot support.
 */
export function billableCachedTokens(spanTokens: number, profile: ProviderProfile): number | null {
  const floor = profile.model.minCacheableTokens.value ?? profile.caching.cacheFloorTokens.value;
  if (floor == null) return null;
  if (spanTokens < floor) return 0;

  const granularity = profile.caching.cacheGranularityTokens.value;
  if (granularity == null || granularity <= 1) return spanTokens;

  const steps = Math.floor((spanTokens - floor) / granularity);
  return floor + steps * granularity;
}
