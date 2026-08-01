import { createHash } from 'node:crypto';

/**
 * SHA-256 from the standard library. Hardware accelerated, no dependency, and
 * we hash kilobytes rather than gigabytes so a faster digest buys nothing.
 */
export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Short form for display. Never used for comparison. */
export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}
