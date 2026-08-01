import { formatCount } from '../../core/format.js';
import { costOfUncachedTokens } from '../cost.js';
import { CLEAN, found, type Detector } from '../types.js';

/**
 * Tokens sitting between two cache steps.
 *
 * When a provider caches in fixed steps above a floor, a span that lands
 * between steps is billed at the lower step and the remainder is charged in
 * full on every request. It is a small amount per request and it is worth
 * reporting because it is invisible and free to fix.
 */
export const granularityWaste: Detector = {
  code: 'GH105',
  title: 'cacheable span aligns with the provider cache step',
  precedence: 60,

  run({ profile, span, spanTokens, totalTokens, billableCachedTokens }) {
    if (billableCachedTokens == null || billableCachedTokens <= 0) return CLEAN;
    const granularity = profile.caching.cacheGranularityTokens.value;
    if (granularity == null || granularity <= 1) return CLEAN;

    const estimate = profile.caching.mode === 'explicit' ? spanTokens : totalTokens;
    const lost = estimate.value - billableCachedTokens;
    if (lost <= 0) return CLEAN;

    const cost = costOfUncachedTokens(lost, profile);

    return found({
      code: 'GH105',
      severity: 'info',
      confidence: 'probable',
      title: 'part of the cacheable span falls between cache steps',
      detail: [
        `${profile.displayName} caches in steps of ${formatCount(granularity)} tokens. The span is about ` +
          `${formatCount(estimate.value)} tokens, so ${formatCount(billableCachedTokens)} are served from cache and ` +
          `${formatCount(lost)} are billed at the full rate on every request.`,
        `This is an estimate with a band of plus or minus ${estimate.bandPct}%, so treat the exact figure as approximate. ` +
          (span.isCandidate
            ? 'It also assumes the whole prompt is shared between requests, which a single request cannot show.'
            : ''),
      ],
      fix:
        `Extend the stable part of the prompt by about ${formatCount(granularity - (lost % granularity))} tokens ` +
        'to reach the next step, or accept the remainder. There is nothing wrong here, it is just unclaimed.',
      ...(cost ? { cost } : {}),
    });
  },
};
