import { describe, expect, it } from 'vitest';
import { formatCount, formatTokens, formatUsd, pluralise } from '../src/core/format.js';

describe('deterministic formatting', () => {
  it('groups thousands without locale', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(-4096)).toBe('-4,096');
  });

  it('makes token counts singular at one', () => {
    expect(formatTokens(1)).toBe('1 token');
    expect(formatTokens(2)).toBe('2 tokens');
    expect(formatTokens(0)).toBe('0 tokens');
    expect(formatTokens(1024)).toBe('1,024 tokens');
  });

  it('scales usd precision to the magnitude', () => {
    expect(formatUsd(0)).toBe('0.00');
    expect(formatUsd(1.5)).toBe('1.50');
    expect(formatUsd(0.0158)).toBe('0.0158');
  });

  it('pluralises a word at anything but one', () => {
    expect(pluralise(1, 'finding')).toBe('finding');
    expect(pluralise(2, 'finding')).toBe('findings');
    expect(pluralise(0, 'prefix', 'prefixes')).toBe('prefixes');
  });
});
