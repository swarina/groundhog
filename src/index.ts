export { inspectRequest, MissingModelError, type InspectOptions } from './engine/inspect.js';
export { renderReport, type RenderOptions } from './report/render.js';
export { CATALOGUE, explain, type CatalogueEntry } from './report/catalogue.js';
export { loadTable, resolveProfile, UnknownProviderError, type LoadOptions, type LoadedTable } from './providers/table.js';
export { detectProvider, adapterFor, AmbiguousProviderError, type Detection } from './providers/adapters/index.js';
export { estimateBlocks, estimateText, compareToThreshold, DEFAULT_TOKENIZER, type TokenizerProfile } from './tokens/estimate.js';
export { serializePrefix, prefixHash, canonicalJson, locate, type OffsetEntry, type SerializedPrefix } from './core/canonical.js';
export { resolveSpan, billableCachedTokens, type SpanResolution } from './core/span.js';
export { sha256, shortHash } from './core/hash.js';

export type {
  Block,
  BlockKind,
  CachingFacts,
  CanonicalPrefix,
  CanonicalRequest,
  Confidence,
  CostImpact,
  Fact,
  FactConfidence,
  Fidelity,
  Finding,
  Location,
  Part,
  Price,
  ProviderId,
  ProviderProfile,
  Report,
  ScopeKeys,
  Severity,
  SkippedCheck,
  SpanSummary,
  TokenEstimate,
  TokenizerFacts,
  TtlOption,
  UsageFields,
} from './types.js';
