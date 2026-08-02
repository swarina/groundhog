import { formatCount, formatPercent, formatTokens, pluralise } from '../core/format.js';
import type { Finding, StabilityReport, TokenEstimate } from '../types.js';
import { renderFindingBlock, wrap, type RenderOptions } from './render.js';

/**
 * Terminal rendering for a stability run.
 *
 * The header carries the number that matters: the effective shared prefix,
 * measured across everything the matrix produced, against the full size of one
 * request. A finding then explains where it broke and why. This shares the
 * finding renderer with the single request report, so a finding reads the same
 * way in both.
 */
export function renderStabilityReport(report: StabilityReport, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const lines: string[] = [];

  lines.push(`${report.provider} / ${report.model}`);
  lines.push(...labelled('measured at', fidelityText(report.fidelity), width));
  lines.push(...labelled('compared', `${formatCount(report.runsCompared)} prefixes across ${report.axes.length} ${pluralise(report.axes.length, 'environment')}`, width));
  lines.push(...labelled('shared prefix', sharedText(report), width));
  lines.push(...labelled('full request', estimateText(report.shared.fullTokens), width));
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('ok  the cacheable prefix was identical across every run');
  }

  for (const finding of report.findings) {
    for (const line of renderFindingBlock(finding, width, options.color ?? false)) lines.push(line);
    lines.push('');
  }

  lines.push(...footer(report, width));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function footer(report: StabilityReport, width: number): string[] {
  const lines: string[] = [];

  if (report.findings.length > 0) {
    const fails = report.findings.filter((finding) => finding.severity === 'fail').length;
    lines.push(`${formatCount(report.findings.length)} ${pluralise(report.findings.length, 'finding')}, ${formatCount(fails)} blocking.`);
  }

  lines.push('environments exercised');
  for (const axis of report.axes) {
    const wrapped = wrap(`${axis.label}: ${axis.description}`, width - 2);
    wrapped.forEach((line, index) => lines.push((index === 0 ? '  ' : '    ') + line));
  }

  if (report.fidelity === 'builder') {
    for (const line of wrap(BUILDER_CAVEAT, width)) lines.push(line);
  }

  if (report.findings.length > 0) {
    const first = report.findings[0] as Finding;
    for (const line of wrap(`Run "groundhog explain ${first.code}" for the full write-up.`, width)) lines.push(line);
  }

  return lines;
}

const BUILDER_CAVEAT =
  'This measured the builder output, not the bytes an sdk sends. An sdk can still normalise content, add defaults, and reserialise, so capture at the wire to be sure what the provider receives.';

function fidelityText(fidelity: StabilityReport['fidelity']): string {
  return fidelity === 'wire'
    ? 'the bytes the sdk was about to send'
    : 'builder output, before any sdk normalisation';
}

function sharedText(report: StabilityReport): string {
  const suffix = report.shared.complete ? ', identical across every run' : ', where the runs stop agreeing';
  return `${estimateText(report.shared.tokens)}${suffix}`;
}

function estimateText(estimate: TokenEstimate): string {
  if (estimate.method === 'exact') return `${formatTokens(estimate.value)} (exact)`;
  return `${formatTokens(estimate.value)} (estimate, plus or minus ${formatPercent(estimate.bandPct)})`;
}

/** Aligned label column, value wrapping under itself. */
function labelled(name: string, value: string, width: number): string[] {
  return wrap(value, width - 14).map((line, index) => (index === 0 ? name.padEnd(14) : ' '.repeat(14)) + line);
}
