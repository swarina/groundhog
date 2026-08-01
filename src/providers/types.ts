import type { CachingFacts, CanonicalRequest, Fact, Price, ProviderId, TokenizerFacts, UsageFields } from '../types.js';

export type { CachingFacts, Price, ProviderProfile, TokenizerFacts, TtlOption, UsageFields } from '../types.js';

export interface DetectRule {
  /** Matched against the request URL when the request was captured at the wire. */
  urlPattern?: string;
  /** Matched against the model identifier in the body. */
  modelPattern?: string;
  bodyRequires?: string[];
  bodyForbids?: string[];
  /** Lower numbers win when several providers match. */
  priority: number;
}

export interface ModelFacts {
  aliases?: string[];
  minCacheableTokens: Fact<number>;
  price: Fact<Price>;
  lastVerified?: string;
}

export interface ProviderEntry {
  displayName: string;
  lastVerified: string;
  docs: string[];
  detect: DetectRule;
  caching: CachingFacts;
  usageFields: UsageFields;
  tokenizer: TokenizerFacts;
  models: Record<string, ModelFacts>;
}

export interface ProviderTable {
  schemaVersion: 1;
  staleAfterDays: number;
  providers: Record<ProviderId, ProviderEntry>;
}

/** Turns a provider specific request body into the canonical shape. */
export interface ProviderAdapter {
  id: ProviderId;
  parse(body: unknown, context: { model?: string; fidelity: 'wire' | 'builder'; wireBytes?: number }): CanonicalRequest;
}
