import type { Detector } from '../types.js';
import { belowMinimum } from './below-minimum.js';
import { breakpointLimit } from './breakpoint-limit.js';
import { granularityWaste } from './granularity-waste.js';
import { lookbackWindow } from './lookback-window.js';
import { noBoundaryDeclared } from './no-boundary.js';
import { routingKey } from './routing-key.js';
import { staleProviderData } from './stale-data.js';

/**
 * Checks that need only one request.
 *
 * Order here is presentation order. Precedence is the number on each detector,
 * so the ranking is a property of the detector rather than of this list.
 */
export const STATIC_DETECTORS: Detector[] = [
  noBoundaryDeclared,
  belowMinimum,
  breakpointLimit,
  lookbackWindow,
  routingKey,
  granularityWaste,
  staleProviderData,
];
