import type { ProbeRun } from './types.js';

/**
 * Turning what was measured into a table override.
 *
 * A run produces a providers.json fragment carrying only the facts it observed,
 * each stamped with the confidence "observed", the date, and a note saying it
 * came from a conformance run. The user reviews it and saves it as an override,
 * so a measured value replaces a reported one without editing the bundled table.
 */

export interface PatchOptions {
  provider: string;
  model: string;
  /** ISO date, supplied by the caller so this stays pure. */
  date: string;
}

interface Fact {
  value: unknown;
  confidence: 'observed';
  source: string;
  note: string;
}

/** Facts that map to a real table field. Others are diagnostic only. */
const PATCHABLE = new Set([
  'model.minCacheableTokens',
  'caching.whitespaceSensitive',
  'caching.toolOrderSensitive',
  'caching.cacheGranularityTokens',
  'caching.unicodeNormalised',
]);

export function buildPatch(runs: ProbeRun[], options: PatchOptions): Record<string, unknown> {
  const source = `conformance run ${options.date}`;
  const caching: Record<string, Fact> = {};
  const model: Record<string, Fact> = {};

  for (const run of runs) {
    const conclusion = run.conclusion;
    if (conclusion.confidence !== 'observed' || conclusion.value == null) continue;
    if (!PATCHABLE.has(conclusion.fact)) continue;

    const fact: Fact = { value: conclusion.value, confidence: 'observed', source, note: conclusion.note };
    const [section, field] = conclusion.fact.split('.') as [string, string];
    if (section === 'model') model[field] = fact;
    else if (section === 'caching') caching[field] = fact;
  }

  const providerEntry: Record<string, unknown> = { lastVerified: options.date };
  if (Object.keys(caching).length > 0) providerEntry['caching'] = caching;
  if (Object.keys(model).length > 0) providerEntry['models'] = { [options.model]: model };

  return {
    schemaVersion: 1,
    providers: { [options.provider]: providerEntry },
  };
}

/** True when a run produced at least one observed, patchable fact. */
export function hasObservations(runs: ProbeRun[]): boolean {
  return runs.some((run) => run.conclusion.confidence === 'observed' && run.conclusion.value != null && PATCHABLE.has(run.conclusion.fact));
}
