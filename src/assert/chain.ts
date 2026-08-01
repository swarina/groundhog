import { checkChain } from '../engine/chain.js';
import { adapterFor, detectProvider } from '../providers/adapters/index.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';
import { renderChainReport } from '../report/chain.js';
import type { CanonicalRequest, ChainReport } from '../types.js';

/**
 * The assertion for a conversation.
 *
 * The input is an ordered list of request bodies, one per turn, which is what a
 * captured agent run produces. Each is parsed and the sequence is checked for
 * prefix reuse from one turn to the next.
 */

export interface ChainCheckOptions extends LoadOptions {
  model: string;
  provider?: string;
}

export class BrokenChainError extends Error {
  readonly report: ChainReport;
  constructor(report: ChainReport, rendered: string) {
    super('\n' + rendered);
    this.name = 'BrokenChainError';
    this.report = report;
  }
}

export function checkPrefixChainOf(bodies: unknown[], options: ChainCheckOptions): ChainReport {
  if (bodies.length < 2) {
    throw new Error(
      `A chain check needs at least two turns and was given ${bodies.length}.\n` +
        'Pass the request from each turn of one conversation, in order.',
    );
  }

  const loaded = loadTable(options);
  const canonical: CanonicalRequest[] = bodies.map((body) => {
    const provider = options.provider ?? detectProvider(loaded.table, body).provider;
    return adapterFor(provider).parse(body, { model: options.model, fidelity: 'builder' });
  });

  const provider = options.provider ?? canonical[0]?.provider;
  if (!provider) throw new Error('Could not identify a provider for these turns. Pass provider.');
  const profile = resolveProfile(loaded, provider, options.model);
  return checkChain(canonical, profile, options.model);
}

/** Throws with a rendered report when the conversation stops reusing its prefix. */
export function expectPrefixChain(bodies: unknown[], options: ChainCheckOptions): void {
  const report = checkPrefixChainOf(bodies, options);
  if (!report.ok) throw new BrokenChainError(report, renderChainReport(report, { color: false }));
}
