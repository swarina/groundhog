import { describe, expect, it } from 'vitest';
import { buildAuditRecord } from '../src/audit/record.js';
import { auditRecords } from '../src/engine/audit.js';

/**
 * The record builder is the bridge from a real request and response to a log
 * line. These check that it hashes the cacheable prefix, so turns of one
 * conversation group together, and that it normalises the provider's usage.
 */

const sys = 'You are a support agent. Answer from the knowledge base. '.repeat(40);
function request(query: string) {
  return {
    model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: query }],
  };
}

const usage = { input_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 };
const opts = { discover: false } as const;

describe('building an audit record', () => {
  it('normalises the provider usage', () => {
    const record = buildAuditRecord({ body: request('hello'), usage, ts: '2026-08-02T09:00:00Z' }, opts);
    expect(record.usage).toEqual({ cacheRead: 2000, cacheWrite: 0, uncached: 100 });
    expect(record.provider).toBe('anthropic');
  });

  it('hashes the cacheable prefix, so two turns with the same system prompt match', () => {
    const a = buildAuditRecord({ body: request('where is my order'), usage, ts: '2026-08-02T09:00:00Z' }, opts);
    const b = buildAuditRecord({ body: request('reset my password'), usage, ts: '2026-08-02T09:01:00Z' }, opts);
    // The final user message differs, but the cached prefix is the same, so the
    // records share a prefix hash and the audit will group them.
    expect(a.prefixHash).toBe(b.prefixHash);
  });

  it('produces records an audit can read', () => {
    const records = [
      buildAuditRecord({ body: request('q1'), usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }, ts: '2026-08-02T09:00:00Z' }, opts),
      buildAuditRecord({ body: request('q2'), usage, ts: '2026-08-02T09:00:10Z' }, opts),
    ];
    const [result] = auditRecords(records, opts);
    expect(result?.totalRequests).toBe(2);
    expect(result?.observedHitRate).toBeCloseTo(0.5, 5);
  });

  it('carries tags through when given', () => {
    const record = buildAuditRecord({ body: request('hi'), usage, ts: '2026-08-02T09:00:00Z', tags: { route: 'support' } }, opts);
    expect(record.tags?.route).toBe('support');
  });
});
