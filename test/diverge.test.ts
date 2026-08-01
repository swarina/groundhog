import { describe, expect, it } from 'vitest';
import { serializePrefix, truncatePrefix } from '../src/core/canonical.js';
import { firstDivergence, sharedPrefix } from '../src/core/diverge.js';
import { estimateBlocks } from '../src/tokens/estimate.js';
import type { CanonicalPrefix } from '../src/types.js';

function prefix(...texts: string[]): CanonicalPrefix {
  return texts.map((text, index) => ({ index, kind: 'system' as const, role: 'system' as const, parts: [{ type: 'text' as const, text }] }));
}

function diverge(left: CanonicalPrefix, right: CanonicalPrefix) {
  return firstDivergence(serializePrefix(left), serializePrefix(right), left);
}

describe('divergence localisation', () => {
  it('reports nothing when the prefixes are identical', () => {
    expect(diverge(prefix('a', 'b'), prefix('a', 'b'))).toBeNull();
  });

  it('names the block and the offset inside its content', () => {
    const found = diverge(prefix('stable header', 'the time is 09:14'), prefix('stable header', 'the time is 09:15'));
    expect(found?.blockIndex).toBe(1);
    expect(found?.sharedBlocks).toBe(1);
    expect(found?.partIndex).toBe(0);
    expect(found?.partType).toBe('text');
    // "the time is 09:1" is sixteen characters, so the first difference is at
    // offset sixteen within the content rather than within our framing.
    expect(found?.offsetInPart).toBe(16);
  });

  it('reports an offset into content, not into the encoding', () => {
    const found = diverge(prefix('abcdef'), prefix('abcXef'));
    expect(found?.offsetInPart).toBe(3);
  });

  it('counts multibyte characters as the bytes they occupy', () => {
    const found = diverge(prefix('café x'), prefix('café y'));
    // Four characters, five bytes, then a space, so the difference is at six.
    expect(found?.offsetInPart).toBe(6);
  });

  it('distinguishes one prefix ending from one prefix changing', () => {
    const truncated = diverge(prefix('a', 'b'), prefix('a'));
    expect(truncated?.isTruncation).toBe(true);

    const changed = diverge(prefix('a', 'b'), prefix('a', 'c'));
    expect(changed?.isTruncation).toBe(false);
  });

  it('finds a divergence in the very first byte of content', () => {
    const found = diverge(prefix('x'), prefix('y'));
    expect(found?.sharedBlocks).toBe(0);
    expect(found?.offsetInPart).toBe(0);
  });

  it('handles a difference past the word aligned scan', () => {
    // The scan compares four bytes at a time and then falls back to single
    // bytes, so a difference at an offset that is not a multiple of four has to
    // land in the same place as any other.
    const base = 'x'.repeat(1000);
    const found = diverge(prefix(base + 'a' + base), prefix(base + 'b' + base));
    expect(found?.offsetInPart).toBe(1000);
  });
});

describe('shared prefix', () => {
  it('is the whole thing when every prefix matches', () => {
    const result = sharedPrefix([prefix('a', 'b'), prefix('a', 'b')]);
    expect(result.complete).toBe(true);
    expect(result.blocks).toBe(2);
  });

  it('stops at the first block any prefix disagrees on', () => {
    const result = sharedPrefix([prefix('a', 'b', 'c'), prefix('a', 'b', 'x'), prefix('a', 'b', 'c')]);
    expect(result.complete).toBe(false);
    expect(result.blocks).toBe(2);
    expect(result.prefix).toHaveLength(2);
  });

  it('is bounded by the worst pair, not the best', () => {
    // One prefix diverging early caps the shared span for the whole set, which
    // is what a provider sees across a real traffic pattern.
    const result = sharedPrefix([prefix('a', 'b', 'c'), prefix('a', 'b', 'x'), prefix('a', 'z', 'c')]);
    expect(result.blocks).toBe(1);
  });

  it('keeps the part of a block that is shared, so it can be measured', () => {
    const left = prefix('the same beginning and then something', 'tail');
    const right = prefix('the same beginning and then different', 'tail');
    const result = sharedPrefix([left, right]);

    expect(result.blocks).toBe(0);
    expect(result.prefix).toHaveLength(1);
    const kept = result.prefix[0]?.parts[0];
    expect(kept?.type).toBe('text');
    expect((kept as { text: string }).text).toBe('the same beginning and then ');
  });

  it('never splits a multibyte character when it truncates', () => {
    const left = prefix('prefix café A');
    const right = prefix('prefix café B');
    const result = sharedPrefix([left, right]);
    const kept = (result.prefix[0]?.parts[0] as { text: string }).text;
    expect(kept).toBe('prefix café ');
    expect(Buffer.from(kept, 'utf8').toString('utf8')).toBe(kept);
  });

  it('produces a shared span that can be counted in tokens', () => {
    const stable = 'the assistant answers questions about billing and shipping. '.repeat(40);
    const result = sharedPrefix([prefix(stable + 'run one'), prefix(stable + 'run two')]);
    const tokens = estimateBlocks(result.prefix);
    expect(tokens.value).toBeGreaterThan(100);
  });

  it('is empty when the prefixes differ from the very start', () => {
    const result = sharedPrefix([prefix('completely different'), prefix('nothing alike')]);
    expect(result.prefix).toHaveLength(0);
    expect(estimateBlocks(result.prefix).value).toBe(0);
  });
});

describe('truncation', () => {
  it('returns nothing for a cut at zero', () => {
    const blocks = prefix('a', 'b');
    expect(truncatePrefix(blocks, serializePrefix(blocks), 0)).toHaveLength(0);
  });

  it('returns everything for a cut past the end', () => {
    const blocks = prefix('a', 'b');
    const serialised = serializePrefix(blocks);
    expect(truncatePrefix(blocks, serialised, serialised.bytes.length)).toHaveLength(2);
  });

  it('drops a binary part rather than halving it', () => {
    const blocks: CanonicalPrefix = [
      {
        index: 0,
        kind: 'message',
        role: 'user',
        parts: [
          { type: 'text', text: 'look at this' },
          { type: 'binary', sha256: 'c'.repeat(64), byteLength: 4096, mime: 'image/png' },
        ],
      },
    ];
    const serialised = serializePrefix(blocks);
    const entry = serialised.map.find((candidate) => candidate.type === 'binary');
    const cut = truncatePrefix(blocks, serialised, (entry?.spanStart ?? 0) + 4);
    expect(cut[0]?.parts.map((part) => part.type)).toEqual(['text']);
  });
});
