/**
 * Shared vocabulary for the whole engine.
 *
 * Nothing in this file knows the name of any provider. Provider specifics
 * arrive as resolved values from the provider data layer.
 */

export type ProviderId = string;

/** How confident we are in a single provider fact. */
export type FactConfidence =
  /** Stated in the provider's own current documentation. */
  | 'documented'
  /** Measured against the live API by the conformance harness. */
  | 'observed'
  /** From a secondary source, not yet verified. Usable, flagged in output. */
  | 'reported'
  /** Derived from a sibling model or family pattern. Weakest usable level. */
  | 'inferred'
  /** Not known. Any check depending on this fact is skipped, not guessed. */
  | 'unknown';

/** A single provider fact carrying its own provenance. */
export interface Fact<T> {
  value: T | null;
  confidence: FactConfidence;
  note?: string;
  source?: string;
}

export type Severity = 'fail' | 'warn' | 'info';

/**
 * Confidence in the stated cause of a finding.
 *
 * This never decides whether a finding exists. A problem reported at
 * 'possible' confidence is still a problem.
 */
export type Confidence = 'certain' | 'probable' | 'possible';

/**
 * Where the request was observed.
 *
 * 'wire' means the bytes an SDK was about to send, which is what the provider
 * actually hashes. 'builder' means the return value of a user function, before
 * SDK normalisation, so it can differ from what is sent.
 */
export type Fidelity = 'wire' | 'builder';

export type BlockKind = 'tools' | 'system' | 'message' | 'toolResult';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'json'; canonical: string }
  | { type: 'binary'; sha256: string; byteLength: number; mime: string };

export interface CacheMarker {
  /** Time to live identifier from the provider table, when the request names one. */
  ttl?: string;
}

export interface Block {
  index: number;
  kind: BlockKind;
  role?: 'user' | 'assistant' | 'system';
  /** Present when the request explicitly declares a cache boundary at this block. */
  cacheMarker?: CacheMarker;
  parts: Part[];
}

export type CanonicalPrefix = Block[];

/**
 * Fields outside the prefix that still partition the cache. Two byte-identical
 * prefixes sent under different scope keys do not share a cache entry.
 */
export interface ScopeKeys {
  model: string;
  /** Provider field that influences backend routing, when the provider has one. */
  routingKey?: string;
  toolChoice?: string;
  responseFormat?: string;
  other?: Record<string, string>;
}

export interface CanonicalRequest {
  provider: ProviderId;
  model: string;
  blocks: CanonicalPrefix;
  scope: ScopeKeys;
  fidelity: Fidelity;
  /** Byte length of the request as the application serialised it, when known. */
  wireBytes?: number;
}

export interface TokenEstimate {
  value: number;
  low: number;
  high: number;
  bandPct: number;
  method: 'estimate' | 'exact';
  /**
   * Parts whose token cost cannot be estimated offline, such as images. When
   * this is above zero the estimate is a lower bound on the real count and
   * threshold checks must not treat it as authoritative.
   */
  unknownParts: number;
}

/** Result of comparing an estimate against a threshold. */
export type ThresholdVerdict = 'above' | 'below' | 'straddles';

export interface Location {
  blockIndex: number;
  blockKind: BlockKind;
  role?: string;
  partIndex?: number;
  byteOffset?: number;
}

export interface CostImpact {
  /** Tokens that are not being served from cache because of this finding. */
  uncachedTokens: number;
  perRequestUncachedUsd: number | null;
  perRequestCachedUsd: number | null;
  deltaUsd: number | null;
  /** Set when price data is missing or unverified, so the renderer can qualify it. */
  priceConfidence: FactConfidence;
}

export interface Finding {
  code: string;
  severity: Severity;
  confidence: Confidence;
  /** One line, states what happened. */
  title: string;
  /** Paragraphs stating where and why. Rendered in order, wrapped by the renderer. */
  detail: string[];
  /** What to do about it. Always present. */
  fix: string;
  location?: Location;
  cost?: CostImpact;
  /**
   * Set when the check could not reach a verdict, usually because a token
   * estimate band crosses a threshold or a provider fact is missing. An
   * uncertain finding never reports as a pass and never silently fails a build.
   */
  uncertain?: boolean;
}

/** A check that could not run, and why. Never silently omitted. */
export interface SkippedCheck {
  code: string;
  title: string;
  reason: string;
}

export interface SpanSummary {
  /** Every block in the request, whether cacheable or not. */
  totalBlocks: number;
  /** Blocks inside the span the request declares or implies as cacheable. */
  cacheableBlocks: number;
  /** Number of explicit cache boundaries declared in the request. */
  declaredMarkers: number;
  boundaryMode: 'explicit' | 'implicit' | 'unknown';
  /** How the span was chosen. Shown to the user so the number is inspectable. */
  basis: string;
  /** True when the span is a candidate rather than a measured shared prefix. */
  isCandidate: boolean;
  /** Minimum cacheable length for this model, carrying its own provenance. */
  minimum: Fact<number>;
  /** Tokens in the cacheable span. */
  spanTokens: TokenEstimate;
  /** Tokens in the whole request prefix. */
  totalTokens: TokenEstimate;
  /**
   * Tokens that would actually be billed at the cached rate once the provider
   * floor and granularity are applied. Null when those facts are unknown.
   */
  billableCachedTokens: number | null;
}

export interface ProviderDataMeta {
  provider: ProviderId;
  lastVerified: string;
  ageDays: number;
  stale: boolean;
  sources: string[];
  /** Layer the merged table came from, so "why that number" is answerable. */
  loadedFrom: string[];
}

/**
 * Resolved provider facts.
 *
 * These shapes live here rather than in the provider layer so the engine can
 * consume them without importing it. The engine receives values, never a
 * provider name it can branch on.
 */

export interface Price {
  currency: string;
  inputPer1M: number;
  outputPer1M: number;
  cachedReadPer1M: number;
  cacheWritePer1M: number;
}

export interface TtlOption {
  id: string;
  seconds: number;
  writeMultiplier: number;
  readMultiplier: number;
  isDefault?: boolean;
  confidence: FactConfidence;
  note?: string;
}

export interface CachingFacts {
  /**
   * 'explicit' means the request declares cache boundaries and nothing is
   * cached without them. 'implicit' means the provider caches the longest
   * matching prefix automatically. 'unknown' means we cannot say, and every
   * check depending on it is skipped.
   */
  mode: 'explicit' | 'implicit' | 'unknown';
  blockOrder: Fact<BlockKind[]>;
  maxBreakpoints: Fact<number>;
  /** Smallest prefix that can be cached at all, when not model specific. */
  cacheFloorTokens: Fact<number>;
  /** Cached spans round down to a multiple of this above the floor. */
  cacheGranularityTokens: Fact<number>;
  lookbackBlocks: Fact<number>;
  /** Request field influencing backend routing, when the provider exposes one. */
  routingKeyField: Fact<string>;
  /** Everything outside the prefix that partitions the cache. */
  scopeDimensions: Fact<string[]>;
  ttls: TtlOption[];
}

export interface UsageFields {
  input: string;
  cacheRead: string;
  cacheWrite: string;
  output: string;
}

export interface TokenizerFacts {
  kind: 'estimate' | 'exact';
  id: string;
  errorBandPct: number;
}

/** One provider resolved for one model. The only provider shape the engine sees. */
export interface ProviderProfile {
  id: ProviderId;
  displayName: string;
  lastVerified: string;
  staleAfterDays: number;
  docs: string[];
  caching: CachingFacts;
  tokenizer: TokenizerFacts;
  usageFields: UsageFields;
  model: {
    id: string;
    resolvedFrom: string;
    /** Model minimum when known, otherwise the provider wide cache floor. */
    minCacheableTokens: Fact<number>;
    price: Fact<Price>;
  };
  loadedFrom: string[];
}

export interface Report {
  reportVersion: 1;
  /** No finding of severity 'fail'. */
  ok: boolean;
  /** No check ended without a verdict. A report can be ok and not certain. */
  certain: boolean;
  provider: ProviderId;
  model: string;
  fidelity: Fidelity;
  span: SpanSummary;
  findings: Finding[];
  skipped: SkippedCheck[];
  providerData: ProviderDataMeta;
}
