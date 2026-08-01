import { describe, expect, it } from 'vitest';
import { classifyCause } from '../src/classify/cause/classify.js';
import { runMatrix } from '../src/runner/matrix.js';
import type { CauseKind } from '../src/classify/cause/types.js';

/**
 * These build anthropic shaped bodies with a known drift injected into a stable
 * base, run them through the matrix, and classify the divergence. The base is
 * long so the divergence sits well inside a shared prefix, the way it would in a
 * real system prompt.
 *
 * The negative cases carry the weight. A classifier that labels a genuine
 * content change as a timestamp is worse than one that says content, so several
 * builders are designed to bait a wrong label.
 */

const base = 'You are a support agent. Answer only from the knowledge base provided below. '.repeat(40);
const opts = { provider: 'anthropic', model: 'claude-sonnet-4-5', clockInstantMs: 1_700_000_000_000 };

function body(systemText: string) {
  return {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'question' }],
  };
}

async function classify(build: (input: number) => unknown, extra: { inputs?: number[]; perturb?: boolean } = {}) {
  const result = await runMatrix(build, { ...opts, ...extra });
  return classifyCause(result);
}

describe('value classification', () => {
  it('names an ISO timestamp with certainty', async () => {
    const cause = await classify(() => body(base + 'now: ' + new Date().toISOString()));
    expect(cause.kind).toBe('timestamp');
    expect(cause.confidence).toBe('certain');
  });

  it('names a uuid with certainty', async () => {
    let n = 0;
    const uuids = ['3f9a2c11-8b1d-4e07-9c3a-1f3b5d7e9a2c', '7c2e1a90-4f5b-4c81-8a2d-9e0f1b2c3d4e', 'a1b2c3d4-5e6f-4a1b-9c8d-2e3f4a5b6c7d'];
    const cause = await classify(() => body(base + 'request: ' + (uuids[n++ % uuids.length] as string)));
    expect(cause.kind).toBe('uuid');
    expect(cause.confidence).toBe('certain');
  });

  it('names an incrementing counter', async () => {
    let n = 100;
    const cause = await classify(() => body(base + 'seq: ' + n++));
    expect(cause.kind).toBe('counter');
    expect(cause.confidence).toBe('certain');
  });

  it('names a high entropy token only as a possibility', async () => {
    const tokens = ['a1b2c3d4e5f60718', 'f9e8d7c6b5a41302', '0f1e2d3c4b5a6978'];
    let n = 0;
    const cause = await classify(() => body(base + 'nonce: ' + (tokens[n++ % tokens.length] as string)));
    expect(cause.kind).toBe('random');
    expect(cause.confidence).toBe('possible');
  });
});

describe('negative cases, which are the load bearing ones', () => {
  it('does not call a genuinely changed document a timestamp, even when it contains one', async () => {
    // The document changes wholesale and happens to open with a date. A byte
    // pattern match would seize on the date. The classifier must see that more
    // than the date differs and call it content.
    const docs = [
      '2026-01-01 the return policy allows fourteen days for a refund on unworn items with a receipt',
      '2026-01-02 shipping is free above fifty dollars and takes three to five business days by default',
    ];
    let n = 0;
    const cause = await classify(() => body(base + 'policy: ' + (docs[n++ % docs.length] as string)));
    expect(cause.kind).toBe('content');
  });

  it('does not call a content hash of changed content a random value it can act on', async () => {
    // The hash is a symptom, not the cause. The content it covers is what
    // changed. Because the surrounding content differs too, this is content.
    const entries = [
      'the knowledge base article about refunds was last edited by the billing team on tuesday',
      'the knowledge base article about shipping was last edited by the logistics team on friday',
    ];
    let n = 0;
    const cause = await classify(() => body(base + 'article: ' + (entries[n++ % entries.length] as string)));
    expect(cause.kind).toBe('content');
  });

  it('does not label reordered prose as a value change', async () => {
    const chunks = [
      'Refunds are available within fourteen days of delivery for unworn items.',
      'Shipping is complimentary on orders over fifty dollars before tax.',
      'Gift cards cannot be returned or exchanged for cash under any circumstances.',
    ];
    const orders = [
      [0, 1, 2],
      [2, 0, 1],
    ];
    let n = 0;
    const cause = await classify(() => {
      const order = orders[n++ % orders.length] as number[];
      return body(base + '\n' + order.map((i) => chunks[i]).join('\n'));
    });
    expect(cause.kind).toBe('ordering');
    expect(cause.confidence).toBe('certain');
  });

  it('does not classify a stable prefix at all', async () => {
    const result = await runMatrix(() => body(base), opts);
    // A complete shared prefix has no divergence, so there is nothing to name.
    expect(result.divergence).toBeNull();
  });
});

describe('per input drift keeps its axis in the message', () => {
  it('marks a uuid that tracks the input as per request data', async () => {
    const cause = await classify((input: number) => body(base + 'tenant token: ' + ['3f9a2c11-8b1d-4e07-9c3a-1f3b5d7e9a2c', '7c2e1a90-4f5b-4c81-8a2d-9e0f1b2c3d4e'][input]), {
      inputs: [0, 1],
      perturb: false,
    });
    expect(cause.kind).toBe('uuid');
  });
});

const KINDS: CauseKind[] = ['timestamp', 'uuid', 'counter', 'random', 'ordering', 'content', 'structural'];
it('every cause kind is one the report knows how to fix', () => {
  // Guards against a kind being added without a matching fix, which would ship
  // a finding with no advice.
  expect(new Set(KINDS).size).toBe(KINDS.length);
});
