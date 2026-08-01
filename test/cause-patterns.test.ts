import { describe, expect, it } from 'vitest';
import { isEpoch, isHighEntropyToken, isInteger, isIso8601, isOpaqueId, isUuid } from '../src/classify/cause/patterns.js';

describe('iso 8601', () => {
  it('accepts dates and datetimes that parse', () => {
    for (const value of ['2026-08-01', '2026-08-01T14:32:08Z', '2026-08-01T14:32:08.395Z', '2026-08-01T14:32:08+05:30']) {
      expect(isIso8601(value), value).toBe(true);
    }
  });

  it('rejects things that only look date shaped', () => {
    for (const value of ['2026-13-45', 'not-a-date', '2026', 'v2.0.1-08-01']) {
      expect(isIso8601(value), value).toBe(false);
    }
  });
});

describe('epoch', () => {
  it('accepts plausible second and millisecond epochs', () => {
    expect(isEpoch('1700000000')).toBe(true);
    expect(isEpoch('1700000000000')).toBe(true);
  });

  it('rejects numbers outside the plausible range', () => {
    // A ten digit id or a small counter must not read as a time.
    expect(isEpoch('9999999999999999')).toBe(false);
    expect(isEpoch('42')).toBe(false);
    expect(isEpoch('1234567890123456')).toBe(false);
  });
});

describe('uuid and opaque ids', () => {
  it('accepts a v4 uuid', () => {
    expect(isUuid('3f9a2c11-8b1d-4e07-9c3a-1f3b5d7e9a2c')).toBe(true);
  });

  it('rejects a hex string that is not uuid shaped', () => {
    expect(isUuid('3f9a2c118b1d4e079c3a1f3b5d7e9a2c')).toBe(false);
  });

  it('accepts a ulid', () => {
    expect(isOpaqueId('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });
});

describe('integers and high entropy tokens', () => {
  it('recognises an integer', () => {
    expect(isInteger('40521')).toBe(true);
    expect(isInteger('not a number')).toBe(false);
  });

  it('recognises a long hex token', () => {
    expect(isHighEntropyToken('a1b2c3d4e5f60718')).toBe(true);
  });

  it('does not call an ordinary word high entropy', () => {
    expect(isHighEntropyToken('shipping')).toBe(false);
  });
});
