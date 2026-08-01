import { formatCount, formatPercent, formatUsd, pluralise } from '../core/format.js';
import type { Finding, Report, TokenEstimate } from '../types.js';

/**
 * Terminal rendering.
 *
 * Plain text, no decorative characters, aligned label column so the numbers can
 * be scanned down. Every finding reads in the same order: what happened, where,
 * why, what to do, what it costs. Colour is off unless asked for, so piped and
 * captured output is identical to what a human sees.
 */

export interface RenderOptions {
  color?: boolean;
  width?: number;
}

const LABEL_WIDTH = 14;

const COLORS = {
  reset: '\u001b[0m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
};

export function renderReport(report: Report, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const paint = painter(options.color ?? false);
  const lines: string[] = [];

  lines.push(paint(`${report.provider} / ${report.model}`, 'bold'));
  lines.push(...label('measured at', fidelityText(report.fidelity), width));
  lines.push(...label('span', spanText(report), width));
  lines.push(...label('prompt', estimateText(report.span.totalTokens), width));
  lines.push(...label('minimum', minimumText(report), width));
  lines.push(...label('boundary', report.span.basis, width));
  if (report.span.billableCachedTokens != null && report.span.billableCachedTokens > 0) {
    lines.push(...label('cached', `${formatCount(report.span.billableCachedTokens)} tokens billed at the cached rate`, width));
  }
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(
      report.skipped.length === 0
        ? 'ok  no problems found in this request'
        : `ok  no problems found, and ${formatCount(report.skipped.length)} ${pluralise(report.skipped.length, 'check')} could not run`,
    );
  }

  for (const finding of report.findings) {
    lines.push(...renderFinding(finding, width, paint));
    lines.push('');
  }

  if (report.skipped.length > 0) {
    lines.push('checks skipped');
    for (const skip of report.skipped) {
      lines.push(`  ${skip.code}  ${skip.title}`);
      for (const line of wrap(skip.reason, width - 9)) lines.push(`         ${line}`);
    }
    lines.push('');
  }

  lines.push(...renderFooter(report, width));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function renderFinding(finding: Finding, width: number, paint: Painter): string[] {
  const lines: string[] = [];
  const tag = finding.severity.toUpperCase().padEnd(4);
  const colored = paint(tag, finding.severity === 'fail' ? 'red' : finding.severity === 'warn' ? 'yellow' : 'dim');
  const headingIndent = 13;
  const heading = wrap(finding.title, width - headingIndent);
  lines.push(`${colored}  ${finding.code}  ${heading[0] ?? ''}`);
  for (const line of heading.slice(1)) lines.push(`${' '.repeat(headingIndent)}${line}`);
  lines.push(`      confidence: ${finding.confidence}${finding.uncertain ? ', no verdict reached' : ''}`);
  lines.push('');

  for (const paragraph of finding.detail) {
    if (!paragraph.trim()) continue;
    for (const line of wrap(paragraph, width - 2)) lines.push(`  ${line}`);
    lines.push('');
  }

  for (const line of wrap(`Fix: ${finding.fix}`, width - 2)) lines.push(`  ${line}`);

  if (finding.cost) {
    lines.push('');
    for (const line of wrap(costText(finding), width - 2)) lines.push(`  ${line}`);
  }

  if (finding.location) {
    const loc = finding.location;
    const at = loc.byteOffset != null ? `byte ${formatCount(loc.byteOffset)}, ` : '';
    lines.push('');
    lines.push(`  Location: ${at}block ${loc.blockIndex} (${loc.blockKind}${loc.role ? ', ' + loc.role : ''})`);
  }

  return lines;
}

function costText(finding: Finding): string {
  const cost = finding.cost;
  if (!cost) return '';
  if (cost.deltaUsd == null) {
    return (
      `Cost: ${formatCount(cost.uncachedTokens)} tokens are billed at the full input rate on every request. ` +
      `Price data for this model is recorded as "${cost.priceConfidence}", so the amount is not shown.`
    );
  }
  const qualifier = cost.priceConfidence === 'documented' || cost.priceConfidence === 'observed' ? '' : ' Prices are unverified.';
  return (
    `Cost: ${formatCount(cost.uncachedTokens)} tokens at the full input rate on every request, ` +
    `${formatUsd(cost.perRequestUncachedUsd ?? 0)} USD instead of ${formatUsd(cost.perRequestCachedUsd ?? 0)} USD, ` +
    `a difference of ${formatUsd(cost.deltaUsd)} USD per request.${qualifier}`
  );
}

function renderFooter(report: Report, width: number): string[] {
  const lines: string[] = [];

  if (report.findings.length > 0) {
    const counts = { fail: 0, warn: 0, info: 0 };
    for (const finding of report.findings) counts[finding.severity] += 1;
    const parts: string[] = [];
    if (counts.fail) parts.push(`${counts.fail} fail`);
    if (counts.warn) parts.push(`${counts.warn} warn`);
    if (counts.info) parts.push(`${counts.info} info`);
    lines.push(`${formatCount(report.findings.length)} ${pluralise(report.findings.length, 'finding')}: ${parts.join(', ')}.`);
  }

  if (!report.certain) {
    for (const line of wrap('One check did not reach a verdict. This run is not a pass. See the finding marked "no verdict reached" above.', width)) {
      lines.push(line);
    }
  }

  for (const line of wrap(
    'This is a single request. Whether its prefix stays identical between requests is a separate question that one request cannot answer.',
    width,
  )) {
    lines.push(line);
  }

  const age = report.providerData.ageDays;
  const ageText = age === 0 ? 'today' : `${formatCount(age)} ${pluralise(age, 'day')} ago`;
  lines.push(`provider data verified ${report.providerData.lastVerified} (${ageText})`);

  if (report.findings.length > 0) {
    const first = report.findings[0];
    if (first) lines.push(`Run "groundhog explain ${first.code}" for the full write-up.`);
  }

  return lines;
}

function fidelityText(fidelity: Report['fidelity']): string {
  return fidelity === 'wire'
    ? 'the bytes the sdk was about to send'
    : 'builder output, before any sdk normalisation';
}

function spanText(report: Report): string {
  if (report.span.boundaryMode === 'explicit') {
    if (report.span.declaredMarkers === 0) return 'none declared, so nothing is cacheable';
    return estimateText(report.span.spanTokens);
  }
  return `${estimateText(report.span.totalTokens)}, candidate only`;
}

function estimateText(estimate: TokenEstimate): string {
  if (estimate.method === 'exact') return `${formatCount(estimate.value)} tokens (exact)`;
  return `${formatCount(estimate.value)} tokens (estimate, plus or minus ${formatPercent(estimate.bandPct)})`;
}

function minimumText(report: Report): string {
  const minimum = report.span.minimum;
  if (minimum.value == null) return 'not recorded for this model, so the qualification check was skipped';
  const verified = minimum.confidence === 'documented' || minimum.confidence === 'observed';
  return `${formatCount(minimum.value)} tokens for this model${verified ? '' : ` (${minimum.confidence}, unverified)`}`;
}

/** Aligned label column, with the value hanging under itself when it wraps. */
function label(name: string, value: string, width: number): string[] {
  const wrapped = wrap(value, width - LABEL_WIDTH);
  return wrapped.map((line, index) => (index === 0 ? name.padEnd(LABEL_WIDTH) : ' '.repeat(LABEL_WIDTH)) + line);
}

type Painter = (text: string, color: keyof typeof COLORS) => string;

function painter(enabled: boolean): Painter {
  if (!enabled) return (text) => text;
  return (text, color) => `${COLORS[color]}${text}${COLORS.reset}`;
}

export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}
