import type { Partition } from '../../core/partition.js';
import type { Confidence } from '../../types.js';
import type { Variant } from './extract.js';

/**
 * What a changing value is.
 *
 * The kind is the literal class, the shape of the value itself. The partition
 * says when it changes: on every call, with the environment, with the input.
 * The two together are what make a fix specific.
 */
export type CauseKind =
  | 'timestamp'
  | 'uuid'
  | 'counter'
  | 'random'
  | 'ordering'
  | 'content'
  | 'structural';

export interface CauseContext {
  variants: Variant[];
  /** Distinct values in first appearance order. */
  distinct: string[];
  partition: Partition;
  /** True when content beyond the token also differs. */
  spanExtendsBeyondToken: boolean;
}

export interface Cause {
  kind: CauseKind;
  confidence: Confidence;
  /** What the classifier observed, stated so it can be shown as evidence. */
  observation: string;
  /** A representative pair of differing values, for the message. */
  example?: { left: string; right: string };
}

export interface CauseDetector {
  kind: CauseKind;
  /** Lower runs first and outranks. Explicit so precedence is inspectable. */
  precedence: number;
  detect(context: CauseContext): Cause | null;
}
