import type { Finding, SkippedCheck } from '../types.js';
import type { Detector, StaticInput } from './types.js';

export interface PipelineResult {
  findings: Finding[];
  skipped: SkippedCheck[];
}

/**
 * Runs every detector and collects everything they report.
 *
 * Detectors are independent, so all of them run even when an earlier one has
 * already found a problem. Precedence orders the output, it does not stop the
 * pipeline. A request with two unrelated problems should show both.
 */
export function runDetectors(detectors: Detector[], input: StaticInput): PipelineResult {
  const findings: Finding[] = [];
  const skipped: SkippedCheck[] = [];

  for (const detector of detectors) {
    const output = detector.run(input);
    if (output.kind === 'finding') findings.push(output.finding);
    else if (output.kind === 'skipped') skipped.push({ code: detector.code, title: detector.title, reason: output.reason });
  }

  const precedence = new Map(detectors.map((d) => [d.code, d.precedence]));
  findings.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (precedence.get(a.code) ?? 999) - (precedence.get(b.code) ?? 999);
  });

  return { findings, skipped };
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'fail' ? 0 : severity === 'warn' ? 1 : 2;
}
