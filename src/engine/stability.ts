import { buildDiffWindow, renderDiffWindow } from '../core/diff.js';
import type { Divergence } from '../core/diverge.js';
import { formatCount } from '../core/format.js';
import { classifyCause } from '../classify/cause/classify.js';
import type { Cause, CauseKind } from '../classify/cause/types.js';
import { costOfUncachedTokens } from '../classify/cost.js';
import { comparablePrefix } from '../core/span.js';
import { compareToThreshold, estimateBlocks } from '../tokens/estimate.js';
import type { CanonicalPrefix, CanonicalRequest, Finding, ProviderProfile, StabilityReport, TokenEstimate } from '../types.js';
import { compareCanonical, runMatrix, type BuildFn, type MatrixOptions, type MatrixResult } from '../runner/matrix.js';

export type { StabilityReport } from '../types.js';

/**
 * Turning a matrix result into a verdict on whether a prefix stays identical.
 *
 * The headline is the effective shared prefix, in tokens, against the model
 * minimum. A provider caches the longest prefix a request shares with an
 * earlier one, so this single number decides whether caching pays across a
 * traffic pattern, and it means the same thing on a provider that caches
 * explicitly and one that caches implicitly with no control surface at all.
 */

const FIX_BY_KIND: Record<CauseKind, string> = {
  timestamp:
    'Move the timestamp out of the cached span, into the final user message below the boundary, or drop it to a ' +
    'coarser granularity if the model only needs the date.',
  uuid: 'Move the identifier below the cache boundary. A request id, trace id, or session id belongs with the request, not in the cached prefix.',
  counter: 'Move the counter out of the cached span. A value that increments on every call cannot be part of a shared prefix.',
  random: 'If this is a generated value, move it below the cache boundary. If it is a content hash, the content it covers is what changed, so look there.',
  ordering:
    'Sort the elements into a stable order before they enter the prompt. Tool definitions, retrieved documents, and object keys ' +
    'assembled from a set need an explicit sort, since their natural order is not stable.',
  content: 'The cached part is carrying content that genuinely differs between requests. Move the varying content below the cache boundary.',
  structural:
    'Keep the block and part structure of the prompt identical between requests. A block that is sometimes present and sometimes ' +
    'absent, or that changes type, breaks the cache even when the text is the same.',
};

/** One line placing the cause in the axis the partition identified. */
function whereClause(cause: Cause, shape: string, dimension?: string): string {
  if (cause.kind === 'ordering' || cause.kind === 'structural') return '';
  if (dimension === 'input') return ' It varies with the input, so it is per request data that has reached the shared prefix.';
  if (dimension === 'environment') return ' It varies with the environment, so it depends on the clock, timezone, or random stream.';
  if (shape === 'varies-per-run') return ' It changes on every call.';
  return '';
}

const CAUSE_LABEL: Record<CauseKind, string> = {
  timestamp: 'a timestamp changes',
  uuid: 'an identifier changes',
  counter: 'a counter increments',
  random: 'a high entropy value changes',
  ordering: 'the order is not stable',
  content: 'the content differs',
  structural: 'the structure differs',
};

function causeLabel(kind: CauseKind): string {
  return CAUSE_LABEL[kind];
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1);
}

function locationText(divergence: Divergence): string[] {
  if (divergence.isStructural) {
    const what = divergence.isTruncation ? 'a block is present on one side and absent on the other' : 'the block or part structure differs';
    return [`The prefixes differ in shape at block ${divergence.blockIndex} (${divergence.blockKind}): ${what}.`];
  }
  const at =
    divergence.offsetInPart != null
      ? `byte ${formatCount(divergence.offsetInPart)} of block ${divergence.blockIndex} (${divergence.blockKind})`
      : `block ${divergence.blockIndex} (${divergence.blockKind})`;
  return [`The prefixes first differ at ${at}, after ${formatCount(divergence.contentByteOffset)} shared content bytes.`];
}

/** Rendered diff lines for the divergent span, or null when there is nothing to show. */
function diffLines(result: MatrixResult): string[] | null {
  const divergence = result.divergence;
  if (!divergence || divergence.partIndex == null || divergence.offsetInPart == null) return null;

  const first = result.runs[0];
  const other = result.runs.find((run) => run.descriptor.hash !== first?.descriptor.hash);
  if (!first || !other) return null;

  const leftBlock = first.prefix.find((block) => block.index === divergence.blockIndex);
  const rightBlock = other.prefix.find((block) => block.index === divergence.blockIndex);
  const leftPart = leftBlock?.parts[divergence.partIndex];
  const rightPart = rightBlock?.parts[divergence.partIndex];
  if (!leftPart || !rightPart) return null;

  const left = leftPart.type === 'text' ? leftPart.text : leftPart.type === 'json' ? leftPart.canonical : '';
  const right = rightPart.type === 'text' ? rightPart.text : rightPart.type === 'json' ? rightPart.canonical : '';
  return renderDiffWindow(buildDiffWindow({ left, right, offset: divergence.offsetInPart }));
}

function summarise(result: MatrixResult, profile: ProviderProfile, model: string): StabilityReport {
  const sharedTokens = estimateBlocks(result.shared.prefix, profile.tokenizer);
  const fullTokens = estimateBlocks(result.runs[0]?.prefix ?? [], profile.tokenizer);
  const findings: Finding[] = [];

  if (!result.shared.complete && result.divergence) {
    const cause = classifyCause(result);
    const lost = fullTokens.value - sharedTokens.value;
    const cost = costOfUncachedTokens(lost, profile);
    const diff = diffLines(result);
    const where = whereClause(cause, result.partition.shape, result.partition.dimension);

    findings.push({
      code: 'GH120',
      severity: 'fail',
      confidence: cause.confidence,
      title: `the cacheable prefix is not identical between runs: ${causeLabel(cause.kind)}`,
      detail: [
        `The effective shared prefix is ${formatCount(sharedTokens.value)} tokens out of ${formatCount(fullTokens.value)} ` +
          `in a full request. Everything past the shared part is billed at the full rate on every request.`,
        capitalise(cause.observation) + '.' + where,
        ...locationText(result.divergence),
      ],
      fix: FIX_BY_KIND[cause.kind],
      location: {
        blockIndex: result.divergence.blockIndex,
        blockKind: result.divergence.blockKind,
        ...(result.divergence.role ? { role: result.divergence.role } : {}),
        ...(result.divergence.partIndex != null ? { partIndex: result.divergence.partIndex } : {}),
        ...(result.divergence.offsetInPart != null ? { byteOffset: result.divergence.offsetInPart } : {}),
      },
      ...(diff ? { diff } : {}),
      ...(cost ? { cost } : {}),
    });
  }

  // The shared prefix can be stable and still too short to cache, so the
  // qualification of the shared figure is reported alongside stability.
  const minimum = profile.model.minCacheableTokens;
  if (minimum.value != null && result.shared.complete) {
    const verdict = compareToThreshold(sharedTokens, minimum.value);
    if (verdict === 'below') {
      findings.push({
        code: 'GH102',
        severity: 'fail',
        confidence: 'certain',
        title: 'the prefix is stable but below the minimum for this model',
        detail: [
          `The prefix is identical across every run, which is what caching needs, but at ${formatCount(sharedTokens.value)} ` +
            `tokens it is below the ${formatCount(minimum.value)} this model requires, so none of it is cached.`,
        ],
        fix: 'Add stable content above the boundary until the prefix clears the minimum.',
      });
    }
  }

  return {
    reportVersion: 1,
    ok: !findings.some((finding) => finding.severity === 'fail'),
    certain: !findings.some((finding) => finding.uncertain),
    provider: profile.id,
    model,
    runsCompared: result.runs.length,
    axes: result.axes,
    shared: { tokens: sharedTokens, fullTokens, complete: result.shared.complete },
    findings,
  };
}

/** Runs a builder across the matrix and reports on prefix stability. */
export async function checkBuilderStability<I>(
  build: BuildFn<I>,
  profile: ProviderProfile,
  options: MatrixOptions<I>,
): Promise<StabilityReport> {
  const prefixOf = (request: CanonicalRequest): CanonicalPrefix => comparablePrefix(request, profile);
  const result = await runMatrix(build, { ...options, prefixOf });
  return summarise(result, profile, options.model);
}

/** Compares already captured requests and reports on prefix stability. */
export function checkCapturedStability(requests: CanonicalRequest[], profile: ProviderProfile, model: string): StabilityReport {
  const prefixOf = (request: CanonicalRequest): CanonicalPrefix => comparablePrefix(request, profile);
  const report = summarise(compareCanonical(requests, prefixOf), profile, model);
  return { ...report, findings: markCaptured(report.findings) };
}

/**
 * Captured requests were built under different inputs by definition, so the
 * matrix axes did not run. The finding notes that the environment axes were not
 * exercised, rather than implying a coverage it did not have.
 */
function markCaptured(findings: Finding[]): Finding[] {
  return findings.map((finding) =>
    finding.code === 'GH120'
      ? { ...finding, detail: [...finding.detail, 'These were captured requests, so the clock and random axes were not exercised. Run the builder directly to test those.'] }
      : finding,
  );
}
