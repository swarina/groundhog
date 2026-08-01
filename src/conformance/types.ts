import type { NormalisedUsage } from '../audit/types.js';

/**
 * Measuring what a provider actually does, rather than believing what it
 * documents.
 *
 * Every other tool in this space guesses at provider behaviour from
 * documentation that is often stale and never complete. This suite sends
 * designed requests to a real endpoint and reads the cache usage back, so a
 * value in the table can carry the confidence "observed" with a date, instead
 * of "reported" from a blog post.
 *
 * It is the only part of the tool that touches a provider, it is opt in, and it
 * never runs on its own. The sender is injected, so the probe logic is exercised
 * offline against a simulated provider whose parameters are known, which is how
 * the probes are trusted before they are ever pointed at a real key.
 */

export interface SendResult {
  usage: NormalisedUsage;
}

/**
 * Sends one request and returns its usage. In production this calls the real
 * API with the user's key. In tests it is a simulated provider.
 */
export type Sender = (body: unknown) => Promise<SendResult>;

export interface ProbeStep {
  label: string;
  body: unknown;
  /** Seconds to wait before sending, for probes that measure the time to live. */
  waitSecondsBefore?: number;
}

export interface Observation {
  label: string;
  usage: NormalisedUsage;
  /** True when any prompt token was served from cache. */
  hit: boolean;
}

export interface Conclusion {
  /** Dotted path of the table field this informs, for the patch. */
  fact: string;
  value: unknown | null;
  confidence: 'observed' | 'unknown';
  /** Plain statement of what was measured, shown to the user. */
  note: string;
}

export interface Probe {
  id: string;
  /** The question this probe answers. */
  question: string;
  steps: ProbeStep[];
  interpret(observations: Observation[]): Conclusion;
  /** Rough number of requests, so the cost of a run can be stated up front. */
  requestCount: number;
  /** Longest wait any step imposes, so a run's duration can be stated. */
  maxWaitSeconds: number;
}

export interface ProbeRun {
  probe: Probe;
  observations: Observation[];
  conclusion: Conclusion;
}
