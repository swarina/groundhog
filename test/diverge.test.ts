import { describe, expect, it } from 'vitest';
import { firstDivergence, sharedPrefix, truncateUtf8 } from '../src/core/diverge.js';
import { estimateBlocks } from '../src/tokens/estimate.js';
import type { Block, CanonicalPrefix, Part } from '../src/types.js';

function prefix(...texts: string[]): CanonicalPrefix {
  return texts.map((text, index) => ({ index, kind: 'system' as const, role: 'system' as const, parts: [{ type: 'text' as const, text }] }));
}

function block(index: number, kind: Block['kind'], parts: Part[], role?: Block['role']): Block {
  return { index, kind, ...(role ? { role } : {}), parts };
}

describe('divergence localisation', () => {
  it('reports nothing when the prefixes are identical', () => {
    expect(firstDivergence(prefix('a', 'b'), prefix('a', 'b'))).toBeNull();
  });

  it('names the block and the offset inside its content', () => {
    const found = firstDivergence(prefix('stable header', 'the time is 09:14'), prefix('stable header', 'the time is 09:15'));
    expect(found?.blockIndex).toBe(1);
    expect(found?.sharedBlocks).toBe(1);
    expect(found?.partIndex).toBe(0);
    expect(found?.offsetInPart).toBe(16);
  });

  it('reports an offset into content, never into the framing', () => {
    // The regression that motivated a structural comparison: two texts of
    // different length differ in their length prefix before their content, and
    // a raw byte comparison would report that framing offset instead of this.
    const found = firstDivergence(prefix('the same start X'), prefix('the same start YYYYYYYY'));
    // "the same start " is fifteen characters, so the first difference is at
    // offset fifteen, in the content, not somewhere in a length header.
    expect(found?.offsetInPart).toBe(15);
    expect(found?.contentByteOffset).toBe(15);
  });

  it('counts multibyte characters as the bytes they occupy', () => {
    const found = firstDivergence(prefix('café x'), prefix('café y'));
    expect(found?.offsetInPart).toBe(6);
  });

  it('accumulates a content offset across earlier blocks', () => {
    const found = firstDivergence(prefix('aaaa', 'bbbb', 'cccc'), prefix('aaaa', 'bbbb', 'cxcc'));
    // Two shared blocks of four bytes each, then one byte into the third.
    expect(found?.contentByteOffset).toBe(9);
    expect(found?.sharedBlocks).toBe(2);
  });

  it('distinguishes a content change from a structural one', () => {
    const content = firstDivergence(prefix('a', 'b'), prefix('a', 'c'));
    expect(content?.isStructural).toBe(false);

    const structural = firstDivergence(
      [block(0, 'system', [{ type: 'text', text: 'a' }])],
      [block(0, 'system', [{ type: 'text', text: 'a' }, { type: 'text', text: 'extra' }])],
    );
    expect(structural?.isStructural).toBe(true);
  });

  it('flags a block that was added as a truncation and a structural change', () => {
    const found = firstDivergence(prefix('a'), prefix('a', 'b'));
    expect(found?.isTruncation).toBe(true);
    expect(found?.isStructural).toBe(true);
    expect(found?.sharedBlocks).toBe(1);
  });

  it('sees a change of block kind as structural before comparing content', () => {
    const found = firstDivergence(
      [block(0, 'system', [{ type: 'text', text: 'same' }], 'system')],
      [block(0, 'message', [{ type: 'text', text: 'same' }], 'user')],
    );
    expect(found?.isStructural).toBe(true);
    expect(found?.offsetInPart).toBeNull();
  });

  it('compares binary parts by digest and never by content', () => {
    const left = [block(0, 'message', [{ type: 'binary', sha256: 'a'.repeat(64), byteLength: 10, mime: 'image/png' }], 'user')];
    const right = [block(0, 'message', [{ type: 'binary', sha256: 'b'.repeat(64), byteLength: 10, mime: 'image/png' }], 'user')];
    const found = firstDivergence(left, right);
    expect(found?.partType).toBe('binary');
    expect(found?.offsetInPart).toBeNull();
    expect(found?.isStructural).toBe(false);
  });

  it('finds a divergence in the very first byte of content', () => {
    const found = firstDivergence(prefix('x'), prefix('y'));
    expect(found?.sharedBlocks).toBe(0);
    expect(found?.offsetInPart).toBe(0);
    expect(found?.contentByteOffset).toBe(0);
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
    expect((kept as { text: string }).text).toBe('the same beginning and then ');
  });

  it('measures shared content even when the diverging texts differ in length', () => {
    // This is the case the raw byte comparison got wrong, collapsing the shared
    // span to nothing because the length prefixes differed first.
    const stable = 'the assistant answers questions about billing. '.repeat(30);
    const result = sharedPrefix([prefix(stable + 'a'), prefix(stable + 'a longer tail entirely')]);
    expect(result.contentBytes).toBe(Buffer.byteLength(stable + 'a', 'utf8'));
    expect(estimateBlocks(result.prefix).value).toBeGreaterThan(100);
  });

  it('never splits a multibyte character when it truncates', () => {
    const result = sharedPrefix([prefix('prefix café A'), prefix('prefix café B')]);
    const kept = (result.prefix[0]?.parts[0] as { text: string }).text;
    expect(kept).toBe('prefix café ');
    expect(Buffer.from(kept, 'utf8').toString('utf8')).toBe(kept);
  });

  it('is empty when the prefixes differ from the very start', () => {
    const result = sharedPrefix([prefix('completely different'), prefix('nothing alike')]);
    expect(result.prefix).toHaveLength(0);
    expect(estimateBlocks(result.prefix).value).toBe(0);
  });

  it('returns a single prefix unchanged', () => {
    const only = prefix('a', 'b');
    const result = sharedPrefix([only]);
    expect(result.complete).toBe(true);
    expect(result.blocks).toBe(2);
  });
});

describe('utf-8 truncation', () => {
  it('never splits a multibyte character', () => {
    // Four bytes for two characters, so a three byte cut steps back to two.
    expect(truncateUtf8('你好', 3)).toBe('你');
  });

  it('returns nothing for a non positive length', () => {
    expect(truncateUtf8('anything', 0)).toBe('');
  });

  it('returns the whole string when the length covers it', () => {
    expect(truncateUtf8('abc', 100)).toBe('abc');
  });
});
