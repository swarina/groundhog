/**
 * Grammar tests for the value classes.
 *
 * Each returns a plain boolean about one value. They are deliberately strict:
 * matching loosely here is how a classifier ends up calling a content hash a
 * timestamp, so a test only passes what it can defend.
 */

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isIso8601(value: string): boolean {
  if (!ISO_8601.test(value)) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

/** Ten or thirteen digits, inside a plausible epoch range for this decade. */
export function isEpoch(value: string): boolean {
  if (!/^\d{10}$|^\d{13}$/.test(value)) return false;
  const seconds = value.length === 13 ? Number(value) / 1000 : Number(value);
  // Roughly 2001 to 2035, so a random ten digit number is not read as a time.
  return seconds > 1_000_000_000 && seconds < 2_050_000_000;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Crockford base32 ulid, or a nanoid or cuid shaped identifier. */
export function isOpaqueId(value: string): boolean {
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return true; // ulid
  if (/^c[a-z0-9]{24}$/.test(value)) return true; // cuid
  if (/^[A-Za-z0-9_-]{12,24}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return true; // nanoid
  return false;
}

export function isInteger(value: string): boolean {
  return /^-?\d{1,15}$/.test(value);
}

/**
 * High entropy hex or base64, long enough that a collision is not plausible.
 *
 * This is the weakest class and the one most likely to be a content hash rather
 * than a volatile value, so it is only ever reported as a possibility.
 */
export function isHighEntropyToken(value: string): boolean {
  if (/^[0-9a-f]{16,}$/i.test(value)) return true;
  if (/^[A-Za-z0-9+/=_-]{22,}$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return false;
}
