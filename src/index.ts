export { inspectRequest, MissingModelError, type InspectOptions } from './engine/inspect.js';
export { checkBuilderStability, checkCapturedStability } from './engine/stability.js';
export { checkChain } from './engine/chain.js';
export { checkStablePrefix, expectStablePrefix, PrefixInstabilityError, type StableCheckOptions } from './assert/index.js';
export { checkPrefixChainOf, expectPrefixChain, BrokenChainError, type ChainCheckOptions } from './assert/chain.js';
export { renderChainReport } from './report/chain.js';
export { runMatrix, compareCanonical, type BuildFn, type MatrixOptions, type MatrixResult } from './runner/matrix.js';
export { firstDivergence, sharedPrefix, type Divergence, type SharedPrefix } from './core/diverge.js';
export { analysePartition, type Partition, type PartitionShape, type RunDescriptor } from './core/partition.js';
export { renderReport, type RenderOptions } from './report/render.js';
export { renderStabilityReport } from './report/stability.js';
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
  ChainReport,
  ChainStep,
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
  StabilityReport,
  TokenEstimate,
  TokenizerFacts,
  TtlOption,
  UsageFields,
} from './types.js';
