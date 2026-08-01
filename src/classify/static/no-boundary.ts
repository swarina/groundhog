import { formatCount } from '../../core/format.js';
import { costOfUncachedTokens } from '../cost.js';
import { CLEAN, found, type Detector } from '../types.js';

/**
 * The request declares no cache boundary on a provider that requires one.
 *
 * This is the largest possible finding and it produces no error from the API.
 * The request succeeds, the response is normal, and every token is billed at
 * full price on every call.
 */
export const noBoundaryDeclared: Detector = {
  code: 'GH101',
  title: 'cache boundary declared',
  precedence: 10,

  run({ profile, span, request, totalTokens, estimate }) {
    if (profile.caching.mode !== 'explicit') return CLEAN;
    if (span.declaredMarkers > 0) return CLEAN;

    // The final block is the varying turn and would not be cached in any case,
    // so the recoverable amount is everything before it, measured rather than
    // apportioned from the total.
    const stable = request.blocks.slice(0, Math.max(0, request.blocks.length - 1));
    const stableTokens = estimate(stable).value;

    const cost = costOfUncachedTokens(stableTokens, profile);

    return found({
      code: 'GH101',
      severity: 'fail',
      confidence: 'certain',
      title: 'no cache boundary is declared, so nothing is being cached',
      detail: [
        `${profile.displayName} caches only what a request explicitly marks. This request marks nothing, ` +
          `so all ${formatCount(totalTokens.value)} tokens of prompt are billed at the full input rate on every call.`,
        'The API does not report an error for this. Requests succeed and responses are normal.',
        `${formatCount(stableTokens)} of those tokens sit before the final turn and are the part worth caching, ` +
          'assuming they are identical between requests, which a single request cannot show.',
      ],
      fix:
        'Mark the end of the stable part of your prompt with the cache control field this provider uses. ' +
        'Everything before the mark is cached, everything after it is not, so the mark belongs after your ' +
        'tool definitions and system prompt and before the per request content.',
      ...(cost ? { cost } : {}),
    });
  },
};
