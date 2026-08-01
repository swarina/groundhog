const VOCABULARY = [
  'the', 'assistant', 'answers', 'questions', 'about', 'billing', 'orders',
  'shipping', 'refunds', 'and', 'account', 'settings', 'using', 'only', 'the',
  'reference', 'material', 'provided', 'below', 'if', 'an', 'answer', 'is',
  'not', 'present', 'say', 'so', 'plainly', 'rather', 'than', 'guessing',
  'quote', 'the', 'relevant', 'policy', 'section', 'when', 'one', 'applies',
];

/**
 * Deterministic filler.
 *
 * Fixtures need prompts of realistic length. Random text would make byte
 * offsets and token counts differ between runs, which is exactly the failure
 * this project exists to detect, so the vocabulary is fixed and the order is
 * positional.
 */
export function filler(words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) {
    out.push(VOCABULARY[i % VOCABULARY.length] as string);
    if (i > 0 && i % 18 === 0) out.push('\n');
  }
  return out.join(' ').trim();
}

/** Expands `{ "$filler": { "words": n } }` anywhere in a fixture. */
export function expandFiller(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandFiller);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const directive = record['$filler'];
    if (directive && typeof directive === 'object') {
      const words = (directive as Record<string, unknown>)['words'];
      return filler(typeof words === 'number' ? words : 100);
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(record)) out[key] = expandFiller(inner);
    return out;
  }
  return value;
}
