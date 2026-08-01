import { runDetectors } from '../classify/pipeline.js';
import { STATIC_DETECTORS } from '../classify/static/index.js';
import { daysSince } from '../core/dates.js';
import { billableCachedTokens, resolveSpan } from '../core/span.js';
import { adapterFor, detectProvider } from '../providers/adapters/index.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';
import type { ProviderTable } from '../providers/types.js';
import { estimateBlocks } from '../tokens/estimate.js';
import type { Fidelity, ProviderId, Report } from '../types.js';

export interface InspectOptions extends LoadOptions {
  /** Skips detection when given. */
  provider?: ProviderId;
  /** Overrides the model in the request body. */
  model?: string;
  /** Request url, when the request was captured at the wire. Aids detection. */
  url?: string;
  /** Defaults to 'builder', which is the weaker of the two. */
  fidelity?: Fidelity;
  wireBytes?: number;
  /** Injected so output is deterministic in tests. */
  now?: Date;
}

export class MissingModelError extends Error {
  constructor() {
    super(
      'No model identifier in the request and none supplied.\n' +
        'Minimum cacheable length and price are both model specific, so the check cannot run without one.\n' +
        'Pass --model on the command line, or model: in the check options.',
    );
    this.name = 'MissingModelError';
  }
}

/**
 * Analyses one request.
 *
 * Everything here is a single pass over a single request, which means it can
 * report on qualification, boundaries, routing and cost, but it cannot report
 * on stability. Stability needs more than one request by definition, and this
 * function never implies otherwise.
 */
export function inspectRequest(body: unknown, options: InspectOptions = {}): Report {
  const loaded = loadTable(options);
  const table: ProviderTable = loaded.table;

  const detection = options.provider
    ? { provider: options.provider, basis: 'supplied by the caller' }
    : detectProvider(table, body, options.url);

  const record = (body ?? {}) as Record<string, unknown>;
  const model = options.model ?? (typeof record['model'] === 'string' ? record['model'] : '');
  if (!model) throw new MissingModelError();

  const fidelity: Fidelity = options.fidelity ?? 'builder';
  const request = adapterFor(detection.provider).parse(body, {
    model,
    fidelity,
    ...(options.wireBytes != null ? { wireBytes: options.wireBytes } : {}),
  });

  const profile = resolveProfile(loaded, detection.provider, model);
  const span = resolveSpan(request, profile);

  const spanTokens = estimateBlocks(span.blocks, profile.tokenizer);
  const totalTokens = estimateBlocks(request.blocks, profile.tokenizer);
  const relevantTokens = profile.caching.mode === 'explicit' ? spanTokens : totalTokens;
  const billable = billableCachedTokens(relevantTokens.value, profile);

  const now = options.now ?? new Date();
  const { findings, skipped } = runDetectors(STATIC_DETECTORS, {
    request,
    profile,
    span,
    spanTokens,
    totalTokens,
    billableCachedTokens: billable,
    estimate: (blocks) => estimateBlocks(blocks, profile.tokenizer),
    now,
  });

  const age = daysSince(profile.lastVerified, now);

  return {
    reportVersion: 1,
    ok: !findings.some((finding) => finding.severity === 'fail'),
    certain: !findings.some((finding) => finding.uncertain),
    provider: detection.provider,
    model,
    fidelity,
    span: {
      totalBlocks: request.blocks.length,
      cacheableBlocks: span.blocks.length,
      declaredMarkers: span.declaredMarkers,
      boundaryMode: span.boundaryMode,
      basis: span.basis,
      isCandidate: span.isCandidate,
      minimum: profile.model.minCacheableTokens,
      spanTokens,
      totalTokens,
      billableCachedTokens: billable,
    },
    findings,
    skipped,
    providerData: {
      provider: detection.provider,
      lastVerified: profile.lastVerified,
      ageDays: age,
      stale: age > profile.staleAfterDays,
      sources: profile.docs,
      loadedFrom: profile.loadedFrom,
    },
  };
}
