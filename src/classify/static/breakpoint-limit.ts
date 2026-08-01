import { formatCount, pluralise } from '../../core/format.js';
import { CLEAN, found, skipped, type Detector } from '../types.js';

/** More cache boundaries declared than the provider accepts. */
export const breakpointLimit: Detector = {
  code: 'GH103',
  title: 'cache boundary count is within the provider limit',
  precedence: 30,

  run({ profile, span }) {
    const max = profile.caching.maxBreakpoints;
    if (max.value == null) {
      return skipped(`the maximum number of cache boundaries for ${profile.displayName} is not recorded.`);
    }
    if (max.value === 0 && span.declaredMarkers === 0) return CLEAN;
    if (span.declaredMarkers <= max.value) return CLEAN;

    if (max.value === 0) {
      return found({
        code: 'GH103',
        severity: 'warn',
        confidence: 'certain',
        title: 'cache boundaries are declared but this provider has no boundary control surface',
        detail: [
          `This request declares ${formatCount(span.declaredMarkers)} cache ${pluralise(span.declaredMarkers, 'boundary', 'boundaries')}, ` +
            `and ${profile.displayName} caches automatically instead. The markers have no effect here.`,
        ],
        fix: 'Remove the cache control markers for this provider. What matters instead is how much of the prompt is identical between requests.',
      });
    }

    return found({
      code: 'GH103',
      severity: 'fail',
      confidence: 'certain',
      title: 'more cache boundaries declared than this provider accepts',
      detail: [
        `This request declares ${formatCount(span.declaredMarkers)} boundaries. ${profile.displayName} accepts ${formatCount(max.value)}.`,
        'Boundaries beyond the limit are not honoured, so part of what you marked as cacheable is not cached.',
      ],
      fix:
        `Reduce to ${formatCount(max.value)} boundaries. Keep the ones at the end of the largest stable sections, ` +
        'since a boundary early in the prompt caches less than one placed after more stable content.',
    });
  },
};
