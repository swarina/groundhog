import { describe, expect, it } from 'vitest';
import { canonicalJson, locate, prefixHash, serializePrefix } from '../src/core/canonical.js';
import type { CanonicalPrefix } from '../src/types.js';

function textBlock(index: number, text: string): CanonicalPrefix[number] {
  return { index, kind: 'system', role: 'system', parts: [{ type: 'text', text }] };
}

describe('canonical json', () => {
  it('sorts keys at every depth so assembly order cannot change the bytes', () => {
    const a = { b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } };
    const b = { a: { c: [{ e: 4, f: 3 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('does not sort array elements, because their order is content', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('prefix serialisation', () => {
  it('produces the same bytes for the same blocks', () => {
    const blocks = [textBlock(0, 'hello'), textBlock(1, 'world')];
    expect(prefixHash(blocks)).toBe(prefixHash([textBlock(0, 'hello'), textBlock(1, 'world')]));
  });

  it('distinguishes content that differs only in block split', () => {
    const oneBlock = [textBlock(0, 'helloworld')];
    const twoBlocks = [textBlock(0, 'hello'), textBlock(1, 'world')];
    expect(prefixHash(oneBlock)).not.toBe(prefixHash(twoBlocks));
  });

  it('cannot be confused by content that looks like a field separator', () => {
    // Length prefixing rather than delimiting is what makes this hold. With a
    // delimiter, these two would serialise identically.
    const a = [textBlock(0, 'a'), textBlock(1, 'b')];
    const b = [textBlock(0, 'asystemb')];
    expect(prefixHash(a)).not.toBe(prefixHash(b));
  });

  it('maps a byte offset back to the block and part that produced it', () => {
    const blocks = [textBlock(0, 'first block text'), textBlock(1, 'second block text')];
    const serialised = serializePrefix(blocks);

    const second = serialised.map.find((entry) => entry.blockIndex === 1);
    expect(second).toBeDefined();

    const located = locate(serialised.map, (second?.payloadStart ?? 0) + 3);
    expect(located?.blockIndex).toBe(1);
    expect(located?.partIndex).toBe(0);
  });

  it('records offsets in bytes rather than characters', () => {
    const blocks = [textBlock(0, 'café'), textBlock(1, 'x')];
    const serialised = serializePrefix(blocks);
    const first = serialised.map[0];
    expect(first).toBeDefined();
    // Five bytes for four characters, because the accented character takes two.
    expect((first?.payloadEnd ?? 0) - (first?.payloadStart ?? 0)).toBe(5);
  });

  it('separates the framing of a part from its content', () => {
    // The payload range is what an offset is reported against, so it must not
    // include the tag byte or the length prefix.
    const serialised = serializePrefix([textBlock(0, 'hello')]);
    const entry = serialised.map[0];
    expect(entry?.spanStart).toBeLessThan(entry?.payloadStart ?? 0);
    expect(entry?.spanEnd).toBe(entry?.payloadEnd);
  });

  it('builds a hash chain where each entry covers every block up to that point', () => {
    const blocks = [textBlock(0, 'a'), textBlock(1, 'b'), textBlock(2, 'c')];
    const full = serializePrefix(blocks);
    const shorter = serializePrefix(blocks.slice(0, 2));

    expect(full.chain[0]).toBe(shorter.chain[0]);
    expect(full.chain[1]).toBe(shorter.chain[1]);
    expect(full.chain).toHaveLength(3);
  });

  it('reports byte length per block', () => {
    const blocks = [textBlock(0, 'short'), textBlock(1, 'a much longer piece of text')];
    const serialised = serializePrefix(blocks);
    expect(serialised.blockBytes).toHaveLength(2);
    expect(serialised.blockBytes[1]).toBeGreaterThan(serialised.blockBytes[0] as number);
    expect(serialised.blockBytes.reduce((a, b) => a + b, 0)).toBe(serialised.bytes.length);
  });

  it('represents binary content by digest and never by its bytes', () => {
    const withImage: CanonicalPrefix = [
      { index: 0, kind: 'message', role: 'user', parts: [{ type: 'binary', sha256: 'a'.repeat(64), byteLength: 1024, mime: 'image/png' }] },
    ];
    const changed: CanonicalPrefix = [
      { index: 0, kind: 'message', role: 'user', parts: [{ type: 'binary', sha256: 'b'.repeat(64), byteLength: 1024, mime: 'image/png' }] },
    ];
    expect(prefixHash(withImage)).not.toBe(prefixHash(changed));

    // The stream carries the digest and never the content, so an image cannot
    // be reconstructed from a prefix and can never reach a terminal.
    const serialised = serializePrefix(withImage);
    expect(serialised.bytes.toString('utf8')).toContain('a'.repeat(64));
    expect(serialised.map[0]?.type).toBe('binary');
  });
});
