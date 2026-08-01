import type { CostImpact, ProviderProfile } from '../types.js';

/**
 * Per request cost of tokens that are being billed at the full input rate
 * instead of the cached read rate.
 *
 * Cost appears only as the unit that makes a finding legible. It is always per
 * request, never aggregated into a trend, and it is omitted entirely rather
 * than estimated when price data is missing.
 */
export function costOfUncachedTokens(uncachedTokens: number, profile: ProviderProfile): CostImpact | undefined {
  if (uncachedTokens <= 0) return undefined;

  const price = profile.model.price.value;
  if (!price) {
    return {
      uncachedTokens,
      perRequestUncachedUsd: null,
      perRequestCachedUsd: null,
      deltaUsd: null,
      priceConfidence: profile.model.price.confidence,
    };
  }

  const uncached = (uncachedTokens / 1_000_000) * price.inputPer1M;
  const cached = (uncachedTokens / 1_000_000) * price.cachedReadPer1M;

  return {
    uncachedTokens,
    perRequestUncachedUsd: uncached,
    perRequestCachedUsd: cached,
    deltaUsd: uncached - cached,
    priceConfidence: profile.model.price.confidence,
  };
}
