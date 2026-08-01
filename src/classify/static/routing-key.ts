import { CLEAN, found, skipped, type Detector } from '../types.js';

/**
 * No routing key on a provider whose cache hits depend on reaching the same
 * backend.
 *
 * This one is invisible in development and gets worse as traffic grows. The
 * prompt is byte perfect, nothing in the application changed, and the hit rate
 * falls anyway because requests are spreading across machines that do not share
 * a cache.
 */
export const routingKey: Detector = {
  code: 'GH106',
  title: 'cache routing key is set',
  precedence: 50,

  run({ profile, request }) {
    const field = profile.caching.routingKeyField;
    if (field.confidence === 'unknown') {
      return skipped(`whether ${profile.displayName} has a cache routing key is not recorded.`);
    }
    if (field.value == null) return CLEAN;
    if (request.scope.routingKey) return CLEAN;

    return found({
      code: 'GH106',
      severity: 'warn',
      confidence: 'probable',
      title: `no ${field.value} set, so cache hits depend on which backend the request reaches`,
      detail: [
        `${profile.displayName} serves cache hits only when a request reaches a backend that already holds the prefix. ` +
          `The ${field.value} field influences that routing, and this request does not set it.`,
        'A single request cannot show the effect. It appears as a hit rate that falls as traffic grows, with no change to the prompt.',
      ],
      fix:
        `Set ${field.value} to a stable identifier shared by requests with the same prefix, such as a prompt version or a route name. ` +
        'Do not use a per user or per request value, since that spreads traffic rather than concentrating it.',
    });
  },
};
