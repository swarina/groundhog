import { daysSince } from '../../core/dates.js';
import { formatCount, pluralise } from '../../core/format.js';
import { CLEAN, found, type Detector } from '../types.js';

/**
 * The provider data used for this run is older than the staleness threshold.
 *
 * Provider caching rules change without notice and without a version number.
 * The tool says how old its facts are rather than presenting them as current.
 */
export const staleProviderData: Detector = {
  code: 'GH110',
  title: 'provider data is current',
  precedence: 90,

  run({ profile, now }) {
    const age = daysSince(profile.lastVerified, now);
    if (age <= profile.staleAfterDays) return CLEAN;

    return found({
      code: 'GH110',
      severity: 'info',
      confidence: 'certain',
      title: 'provider data used for this check is out of date',
      detail: [
        `Data for ${profile.displayName} was last verified on ${profile.lastVerified}, ${formatCount(age)} ` +
          `${pluralise(age, 'day')} ago. Thresholds, limits and prices may have changed since.`,
        ...(profile.docs.length > 0 ? [`Current documentation: ${profile.docs[0]}`] : []),
      ],
      fix:
        'Check the provider documentation and correct anything that has moved in a groundhog.providers.json in your project root. ' +
        'Findings above are still valid for the values shown, which are printed with every run.',
    });
  },
};
