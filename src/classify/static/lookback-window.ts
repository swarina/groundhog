import { formatCount } from '../../core/format.js';
import { CLEAN, found, skipped, type Detector } from '../types.js';

/** The cacheable span reaches further back than the provider will look. */
export const lookbackWindow: Detector = {
  code: 'GH104',
  title: 'cacheable span is inside the provider lookback window',
  precedence: 40,

  run({ profile, span }) {
    const window = profile.caching.lookbackBlocks;
    if (window.value == null) {
      return skipped(`the lookback window for ${profile.displayName} is not recorded, so span length is not checked against it.`);
    }
    if (span.blocks.length <= window.value) return CLEAN;

    return found({
      code: 'GH104',
      severity: 'fail',
      confidence: 'certain',
      title: 'cacheable span reaches beyond the provider lookback window',
      detail: [
        `The span covers ${formatCount(span.blocks.length)} content blocks. ${profile.displayName} looks back ${formatCount(window.value)}.`,
        'Blocks beyond the window are not matched against the cache even when they are byte identical.',
      ],
      fix:
        'Merge adjacent stable blocks into fewer, larger blocks so the span fits inside the window. ' +
        'Block count matters here, not token count.',
    });
  },
};
