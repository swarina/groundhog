import type { CanonicalPrefix, CanonicalRequest, Finding, ProviderProfile, TokenEstimate } from '../types.js';
import type { SpanResolution } from '../core/span.js';

/**
 * Everything a detector is allowed to look at.
 *
 * Detectors are independent. None of them knows that the others exist, and none
 * of them reads the provider table directly. They receive resolved facts, which
 * is what keeps provider names out of this layer entirely.
 */
export interface StaticInput {
  request: CanonicalRequest;
  profile: ProviderProfile;
  span: SpanResolution;
  spanTokens: TokenEstimate;
  totalTokens: TokenEstimate;
  billableCachedTokens: number | null;
  /**
   * Estimates any subset of blocks. Detectors that need to price a hypothetical
   * span use this rather than apportioning a total, which would be a guess.
   */
  estimate(blocks: CanonicalPrefix): TokenEstimate;
  /** Injected so staleness checks and golden output stay deterministic. */
  now: Date;
}

export type DetectorOutput =
  | { kind: 'finding'; finding: Finding }
  /** The check could not run. Never silently omitted from the report. */
  | { kind: 'skipped'; reason: string }
  | { kind: 'clean' };

export interface Detector {
  code: string;
  /** Short label used when the check is reported as skipped. */
  title: string;
  /** Lower runs first and outranks. Explicit so precedence is inspectable. */
  precedence: number;
  run(input: StaticInput): DetectorOutput;
}

export const CLEAN: DetectorOutput = { kind: 'clean' };

export function skipped(reason: string): DetectorOutput {
  return { kind: 'skipped', reason };
}

export function found(finding: Finding): DetectorOutput {
  return { kind: 'finding', finding };
}
