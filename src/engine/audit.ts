import { decompose, type AuditResult } from '../audit/decompose.js';
import { readLog, parseLog } from '../audit/ingest.js';
import type { AuditRecord } from '../audit/types.js';
import { loadTable, resolveProfile, type LoadOptions } from '../providers/table.js';

/**
 * Auditing a log.
 *
 * A log can hold more than one model, so the records are grouped by provider and
 * model and each group is decomposed on its own. Every group carries its own
 * ceiling and its own cost, since the numbers only mean anything against one
 * model's prices and one provider's time to live.
 */

function groupKey(record: AuditRecord): string {
  return record.provider + '\t' + record.model;
}

export function auditRecords(records: AuditRecord[], options: LoadOptions = {}): AuditResult[] {
  const loaded = loadTable(options);
  const groups = new Map<string, AuditRecord[]>();
  for (const record of records) {
    const group = groups.get(groupKey(record)) ?? [];
    group.push(record);
    groups.set(groupKey(record), group);
  }

  const results: AuditResult[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const profile = resolveProfile(loaded, first.provider, first.model);
    results.push(decompose(group, profile));
  }
  // Largest workload first, since that is where the money is.
  return results.sort((a, b) => b.totalRequests - a.totalRequests);
}

export function auditLog(path: string, options: LoadOptions = {}): AuditResult[] {
  const loaded = loadTable(options);
  const records = readLog(path, { profileFor: (provider, model) => resolveProfile(loaded, provider, model) });
  return auditRecords(records, options);
}

export function auditText(text: string, options: LoadOptions = {}): AuditResult[] {
  const loaded = loadTable(options);
  const records = parseLog(text, { profileFor: (provider, model) => resolveProfile(loaded, provider, model) });
  return auditRecords(records, options);
}
