/** Whole days between an ISO date and a reference point. */
export function daysSince(isoDate: string, now: Date): number {
  const then = Date.parse(isoDate + 'T00:00:00Z');
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}
