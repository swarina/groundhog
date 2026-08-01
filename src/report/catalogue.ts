/**
 * Long form write-up for every finding code.
 *
 * A code in terminal output is only useful if it can be looked up. This is what
 * `groundhog explain` prints, and it is deliberately readable without a request
 * in hand.
 */

export interface CatalogueEntry {
  code: string;
  title: string;
  what: string;
  why: string;
  fix: string;
  detects: string[];
}

export const CATALOGUE: Record<string, CatalogueEntry> = {
  GH101: {
    code: 'GH101',
    title: 'No cache boundary declared',
    what: 'The request contains no cache control marker, on a provider that caches nothing without one.',
    why:
      'Providers in this group cache only what a request explicitly marks. Sending no marker is a valid request. ' +
      'It succeeds, the response is normal, and every token is billed at the full input rate on every call. ' +
      'Nothing in the response indicates that caching did not happen.',
    fix:
      'Mark the end of the stable part of the prompt. Everything before the mark is cached and everything after it ' +
      'is not, so the mark belongs after the tool definitions and system prompt and before any per request content.',
    detects: ['caching was never enabled', 'markers lost during a refactor', 'markers set on one code path but not another'],
  },

  GH102: {
    code: 'GH102',
    title: 'Cacheable span is below the model minimum',
    what: 'The span marked cacheable is shorter than the minimum this model will cache.',
    why:
      'Minimums are model specific and they have moved upward over time. An application that cached correctly ' +
      'can stop caching entirely after a model upgrade without one line of its own code changing. As with a missing ' +
      'boundary, there is no error: the request succeeds and every token is billed in full.',
    fix:
      'Add stable content above the boundary until the span clears the minimum, or move to a model with a lower one. ' +
      'Content only counts if it is byte identical on every request, so padding with anything variable does not help.',
    detects: ['model upgraded without revisiting the prompt', 'system prompt trimmed below the threshold', 'boundary placed too early'],
  },

  GH103: {
    code: 'GH103',
    title: 'Cache boundary count outside the provider limit',
    what: 'More cache boundaries are declared than the provider honours, or boundaries are declared on a provider that has none.',
    why:
      'Boundaries beyond the limit are ignored. Part of what was marked as cacheable is therefore not cached, and the ' +
      'request gives no indication of which part.',
    fix: 'Reduce to the supported number, keeping the boundaries that sit at the end of the largest stable sections.',
    detects: ['markers added incrementally until the limit was passed', 'provider specific markers left in place after a provider switch'],
  },

  GH104: {
    code: 'GH104',
    title: 'Cacheable span beyond the provider lookback window',
    what: 'The span covers more content blocks than the provider will look back through.',
    why: 'Blocks past the window are not matched against the cache even when they are byte identical. Block count matters here, not token count.',
    fix: 'Merge adjacent stable blocks into fewer, larger blocks so the span fits inside the window.',
    detects: ['history appended as many small blocks', 'retrieved documents added one block per document'],
  },

  GH105: {
    code: 'GH105',
    title: 'Span falls between cache steps',
    what: 'The provider caches in fixed steps above a floor, and the span lands between two of them.',
    why:
      'A shared prefix is not the same as a cached prefix. A span between steps is billed at the lower step and the ' +
      'remainder is charged at the full rate on every request. It is small, invisible, and free to reclaim.',
    fix: 'Extend the stable part of the prompt to the next step, or accept the remainder. Nothing is broken here.',
    detects: ['prompt length drifting just past a step boundary'],
  },

  GH106: {
    code: 'GH106',
    title: 'No cache routing key set',
    what: 'The provider routes requests to backends and serves a cache hit only when a request reaches one holding the prefix. No routing key is set.',
    why:
      'This is invisible in development and worsens with scale. The prompt is byte perfect and nothing in the application ' +
      'changed, yet the hit rate falls as traffic spreads across machines that do not share a cache.',
    fix:
      'Set the routing key to a stable identifier shared by requests with the same prefix, such as a prompt version or a ' +
      'route name. A per user or per request value makes it worse, since it spreads traffic rather than concentrating it.',
    detects: ['hit rate falling as traffic grows', 'hit rate good in staging and poor in production'],
  },

  GH110: {
    code: 'GH110',
    title: 'Provider data is out of date',
    what: 'The provider facts used for this run were last verified longer ago than the staleness threshold.',
    why:
      'Provider caching rules change without notice and without a version number. Reporting the age of the data is the ' +
      'difference between a tool that ages gracefully and one that quietly starts lying.',
    fix:
      'Check the provider documentation and correct anything that has moved in a groundhog.providers.json in the project ' +
      'root. Every run prints the values it used, so earlier findings remain interpretable.',
    detects: ['a threshold or price that changed since the table was written'],
  },
};

export function explain(code: string): string {
  const entry = CATALOGUE[code.toUpperCase()];
  if (!entry) {
    const known = Object.keys(CATALOGUE).join(', ');
    return `Unknown finding code "${code}".\nKnown codes: ${known}.\n`;
  }
  return [
    `${entry.code}  ${entry.title}`,
    '',
    'What it means',
    entry.what,
    '',
    'Why it matters',
    entry.why,
    '',
    'How to fix it',
    entry.fix,
    '',
    'Situations that produce it',
    ...entry.detects.map((item) => `  ${item}`),
    '',
  ].join('\n');
}
