import { formatCount, formatPercent, pluralise } from '../core/format.js';
import type { ChainReport } from '../types.js';
import { renderFindingBlock, wrap, type RenderOptions } from './render.js';

/**
 * Terminal rendering for a chain check.
 *
 * The header is a compact map of the conversation: one mark per step, so a
 * break is visible at a glance and its position in the conversation is obvious.
 * A finding then explains the first break and its cost.
 */
export function renderChainReport(report: ChainReport, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const lines: string[] = [];

  lines.push(`${report.provider} / ${report.model}`);
  lines.push(pad('conversation', `${formatCount(report.turns)} turns, ${formatCount(report.steps.length)} ${pluralise(report.steps.length, 'step')}`));
  lines.push(pad('chain', chainMap(report)));
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('ok  every turn extends the one before it, so the whole prior context is reused');
  }

  for (const finding of report.findings) {
    for (const line of renderFindingBlock(finding, width, options.color ?? false)) lines.push(line);
    lines.push('');
  }

  lines.push(...footer(report, width));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** One mark per step: a hit that extends the prefix, or a break. */
function chainMap(report: ChainReport): string {
  if (report.steps.length === 0) return 'a chain needs at least two turns';
  const marks = report.steps.map((step) => (step.holds ? 'reuse' : 'break'));
  return marks.join(' -> ');
}

function footer(report: ChainReport, width: number): string[] {
  const lines: string[] = [];

  const held = report.steps.filter((step) => step.holds).length;
  lines.push(`${formatCount(held)} of ${formatCount(report.steps.length)} ${pluralise(report.steps.length, 'step')} reused the prefix.`);

  const broken = report.steps.find((step) => !step.holds);
  if (broken) {
    const fraction = broken.toTurnTokens > 0 ? broken.sharedTokens / broken.toTurnTokens : 0;
    for (const line of wrap(
      `At the first break, turn ${formatCount(broken.toTurn)} reused ${formatPercent(fraction * 100)} of its ${formatCount(broken.toTurnTokens)} tokens.`,
      width,
    )) {
      lines.push(line);
    }
  }

  if (report.findings[0]) lines.push(`Run "groundhog explain ${report.findings[0].code}" for the full write-up.`);
  return lines;
}

function pad(name: string, value: string): string {
  return name.padEnd(14) + value;
}
