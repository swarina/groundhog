import type { ProbeRun } from '../conformance/types.js';
import { wrap, type RenderOptions } from './render.js';

/**
 * Rendering a conformance run.
 *
 * One block per probe: the question it asked and what it found, in plain terms.
 * A probe that could not conclude says so, rather than being dropped, so the
 * reader sees everything that was tried.
 */
export function renderConformance(runs: ProbeRun[], provider: string, model: string, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const lines: string[] = [];

  lines.push(`${provider} / ${model}`);
  lines.push(`measured against the live api, ${runs.length} probes`);
  lines.push('');

  for (const run of runs) {
    const marker = run.conclusion.confidence === 'observed' ? 'measured' : 'no result';
    lines.push(`${marker.padEnd(10)} ${run.probe.id}`);
    for (const line of wrap(run.probe.question, width - 2)) lines.push(`  ${line}`);
    for (const line of wrap(run.conclusion.note, width - 2)) lines.push(`  ${line}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
