import { describe, expect, it } from 'vitest';
import { compareToThreshold, estimateBlocks, estimateText } from '../src/tokens/estimate.js';
import type { CanonicalPrefix, TokenEstimate } from '../src/types.js';

function estimate(value: number, bandPct: number, unknownParts = 0): TokenEstimate {
  return {
    value,
    low: Math.floor(value * (1 - bandPct / 100)),
    high: Math.ceil(value * (1 + bandPct / 100)),
    bandPct,
    method: 'estimate',
    unknownParts,
  };
}

describe('token estimation', () => {
  it('counts nothing for empty content', () => {
    expect(estimateText('', 'text')).toBe(0);
  });

  it('rates structured content as denser than prose', () => {
    const prose = 'the assistant answers questions about billing and shipping for the customer support team';
    const json = '{"name":"lookup_order","parameters":{"type":"object","properties":{"id":{"type":"string"}}}}';
    const prosePerChar = estimateText(prose, 'text') / prose.length;
    const jsonPerChar = estimateText(json, 'json') / json.length;
    expect(jsonPerChar).toBeGreaterThan(prosePerChar);
  });

  it('rates cjk far denser than latin text of the same length', () => {
    const latin = 'a'.repeat(100);
    const cjk = '你'.repeat(100);
    expect(estimateText(cjk, 'text')).toBeGreaterThan(estimateText(latin, 'text') * 2);
  });

  it('widens the band for content it estimates less reliably', () => {
    const latin: CanonicalPrefix = [{ index: 0, kind: 'system', parts: [{ type: 'text', text: 'word '.repeat(400) }] }];
    const cjk: CanonicalPrefix = [{ index: 0, kind: 'system', parts: [{ type: 'text', text: '你好'.repeat(400) }] }];
    expect(estimateBlocks(cjk).bandPct).toBeGreaterThan(estimateBlocks(latin).bandPct);
  });

  it('counts content it cannot estimate as unknown rather than as zero risk', () => {
    const blocks: CanonicalPrefix = [
      {
        index: 0,
        kind: 'message',
        role: 'user',
        parts: [
          { type: 'text', text: 'describe this' },
          { type: 'binary', sha256: 'a'.repeat(64), byteLength: 90_000, mime: 'image/png' },
        ],
      },
    ];
    expect(estimateBlocks(blocks).unknownParts).toBe(1);
  });
});

describe('threshold comparison', () => {
  it('passes only when the whole band clears the threshold', () => {
    expect(compareToThreshold(estimate(2000, 10), 1024)).toBe('above');
  });

  it('fails only when the whole band is below the threshold', () => {
    expect(compareToThreshold(estimate(500, 10), 1024)).toBe('below');
  });

  it('refuses a verdict when the band crosses the threshold', () => {
    // A point estimate would call this a pass. That is the failure this tool
    // must never produce, so the band decides and the answer is no verdict.
    expect(compareToThreshold(estimate(1050, 12), 1024)).toBe('straddles');
  });

  it('refuses a verdict when content could not be counted at all', () => {
    // The estimate is a lower bound with no upper bound, so a pass would be
    // unsupportable even though the point value is under the threshold.
    expect(compareToThreshold(estimate(400, 10, 1), 1024)).toBe('straddles');
  });

  it('still passes when uncountable content sits on top of an already sufficient span', () => {
    expect(compareToThreshold(estimate(5000, 10, 1), 1024)).toBe('above');
  });
});
