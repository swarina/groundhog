import { formatCount, formatPercent, formatUsd, pluralise } from '../core/format.js';
import type { AuditResult } from '../audit/decompose.js';
import type { LossBucket } from '../audit/decompose.js';
import { wrap, type RenderOptions } from './render.js';

/**
 * Terminal rendering for an audit.
 *
 * The shape of the screen is the argument: the observed rate, the rate this
 * traffic could actually reach, and the gap between them broken down by cause,
 * each cause named with what to do about it. Cost is the unit that makes the
 * gap legible, never a chart.
 */

const BUCKET_LABEL: Record<LossBucket, string> = {
  fragment: 'prefix fragmentation',
  'ttl-expiry': 'time to live expiry',
  reconciled: 'routing or scope',
  irreducible: 'necessary cold writes',
};

const BUCKET_FIX: Record<LossBucket, string> = {
  fragment: 'prefixes that appear once and never reuse. Unify them: find the per request value that makes each one unique and move it out of the cached prefix.',
  'ttl-expiry': 'requests that arrived after the cache had expired. Keep the prefix warm, or use the longer time to live if the provider offers one.',
  reconciled: 'requests that should have hit but did not, so the miss is outside the prefix. Set a cache routing key, and check the request is on the same account and region.',
  irreducible: 'the first request for each reused prefix. This cannot be recovered, it is the price of filling the cache.',
};

export function renderAuditResult(result: AuditResult, options: RenderOptions = {}): string {
  const width = options.width ?? 80;
  const lines: string[] = [];

  lines.push(`${result.provider} / ${result.model}`);
  lines.push(pad('requests', `${formatCount(result.totalRequests)} over ${formatDuration(result.timeSpanSeconds)}`));
  lines.push(pad('distinct', `${formatCount(result.distinctPrefixes)} ${pluralise(result.distinctPrefixes, 'prefix', 'prefixes')}`));
  if (result.window) lines.push(pad('window', `${result.window.id}, ${formatDuration(result.window.seconds)}`));
  lines.push('');

  lines.push(pad('observed', formatPercent(result.observedHitRate * 100) + ' hit rate'));
  lines.push(pad('achievable', formatPercent(result.achievableCeiling * 100) + ' given this traffic and window'));
  const recoverable = Math.max(0, result.achievableCeiling - result.observedHitRate);
  lines.push(pad('recoverable', formatPercent(recoverable * 100) + recoverableCost(result)));
  lines.push('');

  if (result.buckets.length === 0) {
    lines.push('every request either hit the cache or was a necessary first write.');
  } else {
    lines.push('where it goes');
    for (const bucket of result.buckets) {
      const share = result.totalRequests > 0 ? bucket.requests / result.totalRequests : 0;
      const cost = bucket.costUsd != null ? `, ${formatUsd(bucket.costUsd)} USD` : '';
      lines.push(`  ${formatPercent(share * 100).padStart(6)}  ${BUCKET_LABEL[bucket.bucket]} (${formatCount(bucket.requests)} ${pluralise(bucket.requests, 'request')}${cost})`);
      for (const line of wrap(BUCKET_FIX[bucket.bucket], width - 10)) lines.push(`          ${line}`);
    }
    lines.push('');
  }

  if (result.topPrefixes.length > 0 && result.distinctPrefixes > 1) {
    lines.push('busiest prefixes');
    for (const prefix of result.topPrefixes) {
      const tag = prefix.reused ? 'reused' : 'seen once';
      lines.push(`  ${formatPercent(prefix.share * 100).padStart(6)}  ${prefix.prefixHash.slice(0, 12)} (${formatCount(prefix.requests)} ${pluralise(prefix.requests, 'request')}, ${tag})`);
    }
    lines.push('');
  }

  lines.push(...footer(result, width));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function renderAudit(results: AuditResult[], options: RenderOptions = {}): string {
  if (results.length === 0) return 'The log held no requests to audit.\n';
  return results.map((result) => renderAuditResult(result, options)).join('\n');
}

function recoverableCost(result: AuditResult): string {
  const recoverableTokens = result.buckets
    .filter((bucket) => bucket.bucket !== 'irreducible')
    .reduce((sum, bucket) => sum + (bucket.costUsd ?? 0), 0);
  if (!result.priceKnown || recoverableTokens <= 0) return '';
  return `, about ${formatUsd(recoverableTokens)} USD across this log`;
}

function footer(result: AuditResult, width: number): string[] {
  const lines: string[] = [];
  if (!result.priceKnown) {
    for (const line of wrap('Prices for this model are not in the provider data, so only token counts are shown. Add prices in a groundhog.providers.json to see cost.', width)) {
      lines.push(line);
    }
  }
  if (result.skippedOtherProvider > 0) {
    lines.push(`${formatCount(result.skippedOtherProvider)} ${pluralise(result.skippedOtherProvider, 'record')} for other models were counted separately.`);
  }
  if (!result.window) {
    for (const line of wrap('No time to live is recorded for this provider, so expiry could not be separated from cold writes.', width)) {
      lines.push(line);
    }
  }
  return lines;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'a moment';
  if (seconds < 90) return `${formatCount(seconds)} ${pluralise(Math.round(seconds), 'second')}`;
  if (seconds < 5400) return `${formatCount(seconds / 60)} ${pluralise(Math.round(seconds / 60), 'minute')}`;
  if (seconds < 172_800) return `${formatCount(seconds / 3600)} ${pluralise(Math.round(seconds / 3600), 'hour')}`;
  return `${formatCount(seconds / 86_400)} ${pluralise(Math.round(seconds / 86_400), 'day')}`;
}

function pad(name: string, value: string): string {
  return name.padEnd(14) + value;
}
