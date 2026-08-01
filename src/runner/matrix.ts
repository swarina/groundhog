import { prefixHash } from '../core/canonical.js';
import { firstDivergence, sharedPrefix, type Divergence } from '../core/diverge.js';
import { analysePartition, type Partition, type RunDescriptor } from '../core/partition.js';
import { adapterFor } from '../providers/adapters/index.js';
import type { ProviderProfile } from '../providers/types.js';
import type { CanonicalPrefix, CanonicalRequest } from '../types.js';
import { BASELINE_LABEL, safePerturbations, type Perturbation } from './perturb.js';

/**
 * Running a request builder across a matrix and comparing what it produced.
 *
 * The matrix has three axes. Repeats of one input in one environment catch
 * anything that changes on every call. Different inputs catch per request data
 * that has leaked above the cache boundary. Different environments catch a
 * dependency on the clock, the timezone or the random stream. A single request
 * check cannot see any of these, because none of them is visible in one
 * request.
 */

export type BuildFn<I> = (input: I) => unknown | Promise<unknown>;

export interface MatrixOptions<I> {
  provider: string;
  model: string;
  inputs?: I[];
  /** Repeats of each input within each environment. */
  repeats?: number;
  /** Set to false to run only the baseline environment. */
  perturb?: boolean;
  /** Instant the clock axes pin to. Injected so a run is reproducible. */
  clockInstantMs?: number;
}

export interface MatrixRun {
  descriptor: RunDescriptor;
  request: CanonicalRequest;
  prefix: CanonicalPrefix;
}

export interface MatrixResult {
  runs: MatrixRun[];
  partition: Partition;
  shared: {
    blocks: number;
    contentBytes: number;
    prefix: CanonicalPrefix;
    complete: boolean;
  };
  /** The first place the baseline runs disagree, when they do. */
  divergence: Divergence | null;
  axes: Array<{ label: string; description: string }>;
}

async function buildCanonical<I>(
  build: BuildFn<I>,
  input: I,
  provider: string,
  model: string,
): Promise<CanonicalRequest> {
  const body = await build(input);
  return adapterFor(provider).parse(body, { model, fidelity: 'builder' });
}

/**
 * Runs the matrix and compares every prefix it produced.
 *
 * Perturbations patch process wide state, so the axes run in sequence rather
 * than concurrently, and each restores before the next begins. The builder is
 * always awaited inside the patched window and never after it.
 */
export async function runMatrix<I>(build: BuildFn<I>, options: MatrixOptions<I>): Promise<MatrixResult> {
  const inputs = options.inputs && options.inputs.length > 0 ? options.inputs : ([undefined] as unknown as I[]);
  const repeats = Math.max(1, options.repeats ?? 3);
  const clockInstant = options.clockInstantMs ?? 0;

  const perturbations: Perturbation[] =
    options.perturb === false
      ? safePerturbations(clockInstant).filter((axis) => axis.label === BASELINE_LABEL)
      : safePerturbations(clockInstant);

  const runs: MatrixRun[] = [];
  let index = 0;

  for (const axis of perturbations) {
    const restore = axis.apply();
    try {
      for (let inputIndex = 0; inputIndex < inputs.length; inputIndex += 1) {
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
          const request = await buildCanonical(build, inputs[inputIndex] as I, options.provider, options.model);
          runs.push({
            descriptor: {
              index: index++,
              inputIndex,
              repeatIndex,
              axis: axis.label,
              hash: prefixHash(request.blocks),
            },
            request,
            prefix: request.blocks,
          });
        }
      }
    } finally {
      restore();
    }
  }

  return summarise(runs, perturbations);
}

/** Same comparison over prefixes captured from real requests rather than built. */
export function compareCanonical(requests: CanonicalRequest[]): MatrixResult {
  const runs: MatrixRun[] = requests.map((request, index) => ({
    descriptor: { index, inputIndex: index, repeatIndex: 0, axis: BASELINE_LABEL, hash: prefixHash(request.blocks) },
    request,
    prefix: request.blocks,
  }));
  return summarise(runs, [{ label: BASELINE_LABEL, description: 'captured requests, compared as sent', apply: () => () => undefined }]);
}

function summarise(runs: MatrixRun[], perturbations: Perturbation[]): MatrixResult {
  const partition = analysePartition(runs.map((run) => run.descriptor));
  const shared = sharedPrefix(runs.map((run) => run.prefix));

  const baseline = runs.filter((run) => run.descriptor.axis === BASELINE_LABEL);
  const first = baseline[0] ?? runs[0];
  let divergence: Divergence | null = null;
  if (first) {
    for (const run of runs) {
      if (run === first) continue;
      const found = firstDivergence(first.prefix, run.prefix);
      if (found && (divergence === null || found.contentByteOffset < divergence.contentByteOffset)) divergence = found;
    }
  }

  return {
    runs,
    partition,
    shared: { blocks: shared.blocks, contentBytes: shared.contentBytes, prefix: shared.prefix, complete: shared.complete },
    divergence,
    axes: perturbations.map((axis) => ({ label: axis.label, description: axis.description })),
  };
}
