import { buildDiffWindow, renderDiffWindow } from '../core/diff.js';
import type { Divergence } from '../core/diverge.js';
import { formatCount } from '../core/format.js';
import type { Partition } from '../core/partition.js';
import { costOfUncachedTokens } from '../classify/cost.js';
import { comparablePrefix } from '../core/span.js';
import { compareToThreshold, estimateBlocks } from '../tokens/estimate.js';
import type { CanonicalPrefix, CanonicalRequest, Confidence, Finding, ProviderProfile, StabilityReport, TokenEstimate } from '../types.js';
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

const FIX_BY_SHAPE: Record<Partition['shape'], string> = {
  stable: '',
  'varies-per-run':
    'A value is generated on each call. Look for a timestamp, a uuid, a random sample, or a counter in the ' +
    'cached span, and move it below the cache boundary or remove it.',
  'varies-by-input':
    'Per request data is sitting in the part meant to be shared. Move the user, tenant, or session specific ' +
    'value out of the cached prefix and into the final message.',
  'varies-by-environment':
    'The prefix depends on the clock, the timezone, or the random stream. Move that dependency below the cache ' +
    'boundary, or pin it, so the cached part is the same on every machine and every day.',
  mixed:
    'The order of something in the prefix is not stable. Look for tool definitions from an unordered registry, ' +
    'retrieved documents in a nondeterministic rank order, or object keys assembled in varying order, and sort them.',
};

function confidenceForShape(shape: Partition['shape']): Confidence {
  // The environment and input shapes are demonstrated by a clean split along an
  // axis, so they are stated with more confidence than the mixed case, which
  // only narrows the cause to ordering.
  if (shape === 'varies-by-environment' || shape === 'varies-by-input') return 'probable';
  if (shape === 'varies-per-run') return 'probable';
  return 'possible';
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
    const shape = result.partition.shape;
    const lost = fullTokens.value - sharedTokens.value;
    const cost = costOfUncachedTokens(lost, profile);
    const diff = diffLines(result);

    findings.push({
      code: 'GH120',
      severity: 'fail',
      confidence: confidenceForShape(shape),
      title: 'the cacheable prefix is not identical between runs',
      detail: [
        `The effective shared prefix is ${formatCount(sharedTokens.value)} tokens out of ${formatCount(fullTokens.value)} ` +
          `in a full request. Everything past the shared part is billed at the full rate on every request.`,
        result.partition.evidence + '.',
        ...locationText(result.divergence),
      ],
      fix: FIX_BY_SHAPE[shape],
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
