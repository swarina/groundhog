/**
 * Grouping many prefixes by hash, and reading the shape of the result.
 *
 * The shape is better evidence than any diff. Pattern matching a divergent span
 * guesses at a cause from what the bytes look like. The partition demonstrates
 * one: if every prefix produced under a frozen clock is identical and every
 * prefix produced under a moved clock is identical, and the two groups differ,
 * that is a clock dependency shown rather than inferred.
 */

export interface RunDescriptor {
  index: number;
  /** Which input in the matrix produced this run. */
  inputIndex: number;
  /** Which repetition of that input. */
  repeatIndex: number;
  /** Which environment this run was produced under. */
  axis: string;
  hash: string;
}

export type PartitionShape =
  | 'stable'
  | 'varies-per-run'
  | 'varies-by-input'
  | 'varies-by-environment'
  | 'mixed';

export interface PartitionGroup {
  hash: string;
  runs: number[];
}

export interface Partition {
  groups: PartitionGroup[];
  shape: PartitionShape;
  /** Named when the shape points at one dimension. */
  dimension?: 'input' | 'environment';
  /** Plain account of what the grouping shows. Appears in output verbatim. */
  evidence: string;
}

function groupBy(runs: RunDescriptor[]): PartitionGroup[] {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    const existing = groups.get(run.hash);
    if (existing) existing.push(run.index);
    else groups.set(run.hash, [run.index]);
  }
  return [...groups.entries()].map(([hash, indexes]) => ({ hash, runs: indexes }));
}

/** True when the hash is a function of this dimension and varies with it. */
function alignsWith(runs: RunDescriptor[], key: (run: RunDescriptor) => string): boolean {
  const byValue = new Map<string, Set<string>>();
  for (const run of runs) {
    const value = key(run);
    const hashes = byValue.get(value) ?? new Set<string>();
    hashes.add(run.hash);
    byValue.set(value, hashes);
  }
  if (byValue.size < 2) return false;
  for (const hashes of byValue.values()) {
    if (hashes.size !== 1) return false;
  }
  const distinct = new Set([...byValue.values()].map((hashes) => [...hashes][0] as string));
  return distinct.size > 1;
}

export function analysePartition(runs: RunDescriptor[]): Partition {
  const groups = groupBy(runs);

  if (groups.length <= 1) {
    return {
      groups,
      shape: 'stable',
      evidence: `all ${runs.length} prefixes were byte identical`,
    };
  }

  if (groups.length === runs.length && runs.length > 1) {
    return {
      groups,
      shape: 'varies-per-run',
      evidence:
        `every one of the ${runs.length} prefixes differed from every other, including repeats of the same input ` +
        'in the same environment, which means something changes on each call rather than with the input or the environment',
    };
  }

  if (alignsWith(runs, (run) => run.axis)) {
    return {
      groups,
      shape: 'varies-by-environment',
      dimension: 'environment',
      evidence:
        `the prefix is identical within each environment and differs between them, across ${groups.length} groups, ` +
        'which demonstrates a dependency on the environment rather than on the input',
    };
  }

  if (alignsWith(runs, (run) => String(run.inputIndex))) {
    return {
      groups,
      shape: 'varies-by-input',
      dimension: 'input',
      evidence:
        `the prefix is identical for repeats of the same input and differs between inputs, across ${groups.length} groups, ` +
        'which means per request data is sitting inside the part meant to be shared',
    };
  }

  return {
    groups,
    shape: 'mixed',
    evidence:
      `the ${runs.length} prefixes fell into ${groups.length} groups that do not line up with the input or the environment, ` +
      'which points at ordering that is not stable rather than at a single varying value',
  };
}
