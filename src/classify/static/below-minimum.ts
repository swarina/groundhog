import { formatCount, formatPercent } from '../../core/format.js';
import { compareToThreshold } from '../../tokens/estimate.js';
import { costOfUncachedTokens } from '../cost.js';
import { CLEAN, found, skipped, type Detector, type StaticInput } from '../types.js';

/**
 * The cacheable span is too short to qualify for this model.
 *
 * Minimums are model specific and they have moved upward, so an application
 * that cached correctly before a model upgrade can stop caching entirely
 * without a single line of its own code changing. Nothing in the API response
 * indicates this.
 */
export const belowMinimum: Detector = {
  code: 'GH102',
  title: 'cacheable span meets the model minimum',
  precedence: 20,

  run(input: StaticInput) {
    const { profile, span } = input;
    const minimum = profile.model.minCacheableTokens;

    if (minimum.value == null) {
      return skipped(
        `no minimum cacheable length is recorded for ${profile.model.id}. ` +
          (minimum.note ?? 'Add one to a groundhog.providers.json to enable this check.'),
      );
    }

    // A request with no declared boundary is already reported by the boundary
    // check. Reporting it twice would put two causes on one problem.
    if (profile.caching.mode === 'explicit' && span.blocks.length === 0) return CLEAN;

    const estimate = profile.caching.mode === 'explicit' ? input.spanTokens : input.totalTokens;
    const verdict = compareToThreshold(estimate, minimum.value);
    if (verdict === 'above') return CLEAN;

    const provenance = provenanceLine(minimum.confidence, minimum.value, profile.model.id, minimum.note);
    const shortfall = minimum.value - estimate.value;

    if (verdict === 'straddles') {
      return found({
        code: 'GH102',
        severity: 'warn',
        confidence: 'possible',
        uncertain: true,
        title: 'cannot confirm the cacheable span reaches the model minimum',
        detail: [
          `The span is estimated at ${formatCount(estimate.value)} tokens, plus or minus ${formatPercent(estimate.bandPct)}, ` +
            `which puts it between ${formatCount(estimate.low)} and ${formatCount(estimate.high)}. ` +
            `The minimum for this model is ${formatCount(minimum.value)}, and that range crosses it.`,
          estimate.unknownParts > 0
            ? `${formatCount(estimate.unknownParts)} parts of this request cannot be counted offline, such as images, ` +
              'so the estimate is a lower bound rather than a range.'
            : 'This check reports uncertainty rather than a pass, because a wrong pass here is worse than no answer.',
          provenance,
        ],
        fix:
          `Add roughly ${formatCount(Math.max(0, minimum.value - estimate.low))} tokens of stable content above the boundary ` +
          'to clear the minimum with margin, or count exactly to resolve this.',
      });
    }

    const cost = costOfUncachedTokens(estimate.value, profile);

    return found({
      code: 'GH102',
      severity: 'fail',
      confidence: 'certain',
      title: 'cacheable span is below the minimum for this model, so nothing is cached',
      detail: [
        `The span is ${formatCount(estimate.value)} tokens, at most ${formatCount(estimate.high)} allowing for estimation error. ` +
          `This model requires ${formatCount(minimum.value)}. Nothing in this request is being cached.`,
        'The API does not report an error when a span falls below the minimum. The request succeeds and every token is billed in full.',
        provenance,
      ],
      fix:
        `Add about ${formatCount(shortfall)} more tokens of stable content above the boundary, or use a model with a lower minimum. ` +
        'Content only counts toward the minimum if it is identical on every request.',
      ...(cost ? { cost } : {}),
    });
  },
};

function provenanceLine(
  confidence: string,
  value: number,
  modelId: string,
  note: string | undefined,
): string {
  const base = `The ${formatCount(value)} token minimum for ${modelId} is recorded as "${confidence}" in the provider data.`;
  if (confidence === 'documented' || confidence === 'observed') return base;
  return `${base} ${note ?? 'It has not been verified against the live API.'} Override it in a groundhog.providers.json if you know better.`;
}
