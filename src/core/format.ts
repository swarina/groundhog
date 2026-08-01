/**
 * Deterministic formatting.
 *
 * Nothing here uses locale aware formatting. A tool that reports on
 * nondeterminism must not produce different output on different machines, and
 * locale sensitive number formatting is one of the drift causes it looks for.
 */

export function formatCount(value: number): string {
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? '-' + out : out;
}

export function formatUsd(value: number): string {
  if (value === 0) return '0.00';
  const abs = Math.abs(value);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toFixed(decimals);
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? singular + 's');
}
