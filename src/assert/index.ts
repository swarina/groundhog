import { checkBuilderStability, type StabilityReport } from '../engine/stability.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';
import { renderStabilityReport } from '../report/stability.js';
import type { BuildFn, MatrixOptions } from '../runner/matrix.js';

/**
 * The assertion a test imports.
 *
 * It runs the builder across the matrix, and when the cacheable prefix is not
 * identical it throws an error whose message is the rendered report, so a test
 * runner shows the byte offset, the diff, and the fix rather than a bare
 * "expected true". A stable prefix returns quietly.
 */

export interface StableCheckOptions<I> extends LoadOptions {
  model: string;
  provider: string;
  inputs?: I[];
  repeats?: number;
  perturb?: boolean;
  clockInstantMs?: number;
  /** Fail the assertion when a check reaches no verdict, not only on failure. */
  strict?: boolean;
}

export class PrefixInstabilityError extends Error {
  readonly report: StabilityReport;
  constructor(report: StabilityReport, rendered: string) {
    super('\n' + rendered);
    this.name = 'PrefixInstabilityError';
    this.report = report;
  }
}

export async function checkStablePrefix<I>(build: BuildFn<I>, options: StableCheckOptions<I>): Promise<StabilityReport> {
  const loaded = loadTable(options);
  const profile = resolveProfile(loaded, options.provider, options.model);

  const matrixOptions: MatrixOptions<I> = {
    provider: options.provider,
    model: options.model,
    ...(options.inputs ? { inputs: options.inputs } : {}),
    ...(options.repeats != null ? { repeats: options.repeats } : {}),
    ...(options.perturb != null ? { perturb: options.perturb } : {}),
    ...(options.clockInstantMs != null ? { clockInstantMs: options.clockInstantMs } : {}),
  };

  return checkBuilderStability(build, profile, matrixOptions);
}

/** Throws with a rendered report when the prefix is unstable. */
export async function expectStablePrefix<I>(build: BuildFn<I>, options: StableCheckOptions<I>): Promise<void> {
  const report = await checkStablePrefix(build, options);
  const failed = !report.ok || (options.strict === true && !report.certain);
  if (failed) throw new PrefixInstabilityError(report, renderStabilityReport(report, { color: false }));
}
