import { describe, expect, it } from 'vitest';
import { analysePartition, type RunDescriptor } from '../src/core/partition.js';

let counter = 0;
function run(inputIndex: number, repeatIndex: number, axis: string, hash: string): RunDescriptor {
  return { index: counter++, inputIndex, repeatIndex, axis, hash };
}

describe('partition shape', () => {
  it('calls a single group stable', () => {
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h1'),
      run(1, 0, 'clock', 'h1'),
    ]);
    expect(result.shape).toBe('stable');
  });

  it('calls it per run when repeats of one input in one environment all differ', () => {
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h2'),
      run(0, 2, 'baseline', 'h3'),
    ]);
    expect(result.shape).toBe('varies-per-run');
    expect(result.evidence).toContain('each call');
  });

  it('demonstrates an environment dependency rather than inferring one', () => {
    const result = analysePartition([
      run(0, 0, 'clock-frozen', 'h1'),
      run(1, 0, 'clock-frozen', 'h1'),
      run(0, 0, 'clock-moved', 'h2'),
      run(1, 0, 'clock-moved', 'h2'),
    ]);
    expect(result.shape).toBe('varies-by-environment');
    expect(result.dimension).toBe('environment');
  });

  it('separates per input drift from environment drift', () => {
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h1'),
      run(1, 0, 'baseline', 'h2'),
      run(1, 1, 'baseline', 'h2'),
    ]);
    expect(result.shape).toBe('varies-by-input');
    expect(result.dimension).toBe('input');
  });

  it('does not claim an axis when the grouping does not follow one', () => {
    // Negative case. Two groups exist but neither dimension explains them, so
    // naming a cause here would be a guess dressed as evidence.
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h2'),
      run(1, 0, 'baseline', 'h1'),
      run(1, 1, 'baseline', 'h1'),
    ]);
    expect(result.shape).toBe('mixed');
    expect(result.dimension).toBeUndefined();
  });

  it('does not call a dimension responsible when it only has one value', () => {
    // Every run is in the same environment, so the environment cannot be what
    // distinguishes the groups even though the hashes differ.
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h2'),
    ]);
    expect(result.shape).toBe('varies-per-run');
  });

  it('groups runs by hash so each group can be reported', () => {
    const result = analysePartition([
      run(0, 0, 'baseline', 'h1'),
      run(0, 1, 'baseline', 'h2'),
      run(0, 2, 'baseline', 'h1'),
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.runs).toHaveLength(2);
  });
});
