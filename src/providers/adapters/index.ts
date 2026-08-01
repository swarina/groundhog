import type { ProviderId } from '../../types.js';
import type { ProviderAdapter, ProviderTable } from '../types.js';
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter, openaiCompatibleAdapter } from './openai.js';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  'openai-compatible': openaiCompatibleAdapter,
};

export function adapterFor(provider: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(
      `No request adapter for provider "${provider}".\n` +
        `Adapters available: ${Object.keys(ADAPTERS).join(', ')}.\n` +
        'A provider in the data table also needs an adapter to parse its request shape.',
    );
  }
  return adapter;
}

export interface Detection {
  provider: ProviderId;
  /** How the provider was identified, so the result is inspectable. */
  basis: string;
}

export class AmbiguousProviderError extends Error {
  constructor(candidates: ProviderId[]) {
    super(
      `Cannot tell which provider this request is for. Candidates: ${candidates.join(', ')}.\n` +
        'Pass --provider on the command line, or provider: in the check options.',
    );
    this.name = 'AmbiguousProviderError';
  }
}

/**
 * Detection is data driven so adding a provider stays a table entry.
 *
 * The URL is the strongest signal and is always present when a request was
 * captured at the wire. The model identifier is next. Body shape is last and
 * only ever selects the generic compatible entry, because two providers sharing
 * a wire shape cannot be told apart from the body alone.
 */
export function detectProvider(
  table: ProviderTable,
  body: unknown,
  url?: string,
): Detection {
  const entries = Object.entries(table.providers).sort((a, b) => a[1].detect.priority - b[1].detect.priority);
  const record = (body ?? {}) as Record<string, unknown>;
  const model = typeof record['model'] === 'string' ? record['model'] : '';

  if (url) {
    for (const [id, entry] of entries) {
      const pattern = entry.detect.urlPattern;
      if (pattern && new RegExp(pattern).test(url)) {
        return { provider: id, basis: `request url matched ${pattern}` };
      }
    }
  }

  if (model) {
    for (const [id, entry] of entries) {
      const pattern = entry.detect.modelPattern;
      if (pattern && new RegExp(pattern).test(model)) {
        return { provider: id, basis: `model "${model}" matched ${pattern}` };
      }
    }
  }

  const shapeMatches = entries.filter(([, entry]) => {
    const requires = entry.detect.bodyRequires ?? [];
    const forbids = entry.detect.bodyForbids ?? [];
    return requires.every((key) => key in record) && forbids.every((key) => !(key in record));
  });

  const generic = shapeMatches.filter(([, entry]) => !entry.detect.urlPattern && !entry.detect.modelPattern);
  if (generic.length === 1) {
    const only = generic[0];
    if (only) return { provider: only[0], basis: 'request body shape, provider not otherwise identifiable' };
  }

  if (shapeMatches.length > 1) throw new AmbiguousProviderError(shapeMatches.map(([id]) => id));
  const single = shapeMatches[0];
  if (single) return { provider: single[0], basis: 'request body shape' };

  throw new Error(
    'Could not identify a provider for this request.\n' +
      'The body did not match any provider in the table.\n' +
      'Pass --provider on the command line, or add the provider to a groundhog.providers.json in your project root.',
  );
}
