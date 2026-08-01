import { describe, expect, it } from 'vitest';
import { AmbiguousProviderError, detectProvider } from '../src/providers/adapters/index.js';
import { anthropicAdapter } from '../src/providers/adapters/anthropic.js';
import { openaiAdapter } from '../src/providers/adapters/openai.js';
import { loadTable, resolveProfile, UnknownProviderError } from '../src/providers/table.js';

const bundled = loadTable({ discover: false });

describe('provider table', () => {
  it('records provenance for every caching fact', () => {
    for (const [id, entry] of Object.entries(bundled.table.providers)) {
      for (const [name, fact] of Object.entries(entry.caching)) {
        if (name === 'mode' || name === 'ttls') continue;
        expect((fact as { confidence?: string }).confidence, `${id}.${name} has no confidence`).toBeTruthy();
      }
    }
  });

  it('never records a value without saying where it came from', () => {
    for (const [id, entry] of Object.entries(bundled.table.providers)) {
      for (const [modelId, model] of Object.entries(entry.models)) {
        const minimum = model.minCacheableTokens;
        if (minimum.value != null && minimum.confidence !== 'documented' && minimum.confidence !== 'observed') {
          expect(minimum.note ?? minimum.source, `${id}/${modelId} minimum is unverified with no note`).toBeTruthy();
        }
      }
    }
  });

  it('resolves a model through its alias pattern', () => {
    const profile = resolveProfile(bundled, 'anthropic', 'claude-sonnet-4-5-20260101');
    expect(profile.model.resolvedFrom).toBe('claude-sonnet-4-5');
    expect(profile.model.minCacheableTokens.value).toBe(1024);
  });

  it('falls back to the provider wide floor when a model has no minimum of its own', () => {
    const profile = resolveProfile(bundled, 'openai', 'gpt-4o');
    expect(profile.model.minCacheableTokens.value).toBe(1024);
  });

  it('leaves the fact unknown rather than borrowing one when nothing is recorded', () => {
    const profile = resolveProfile(bundled, 'openai-compatible', 'some-local-model');
    expect(profile.model.minCacheableTokens.value).toBeNull();
    expect(profile.model.minCacheableTokens.confidence).toBe('unknown');
  });

  it('reports an unknown provider by name and says how to add it', () => {
    expect(() => resolveProfile(bundled, 'not-a-provider', 'x')).toThrow(UnknownProviderError);
    try {
      resolveProfile(bundled, 'not-a-provider', 'x');
    } catch (error) {
      expect((error as Error).message).toContain('groundhog.providers.json');
    }
  });
});

describe('table overrides', () => {
  it('corrects one value without restating the rest of the entry', () => {
    const overridden = loadTable({
      discover: false,
      table: {
        schemaVersion: 1,
        staleAfterDays: 90,
        providers: {
          anthropic: {
            models: { 'claude-sonnet-4-5': { minCacheableTokens: { value: 8192, confidence: 'observed' } } },
          },
        },
      } as never,
    });

    const profile = resolveProfile(overridden, 'anthropic', 'claude-sonnet-4-5');
    expect(profile.model.minCacheableTokens.value).toBe(8192);
    expect(profile.model.minCacheableTokens.confidence).toBe('observed');
    // Untouched siblings survive the merge.
    expect(profile.caching.maxBreakpoints.value).toBe(4);
    expect(profile.model.price.value?.inputPer1M).toBe(3);
  });

  it('names every layer it loaded so a value can be traced', () => {
    expect(bundled.loadedFrom.length).toBeGreaterThan(0);
    expect(bundled.loadedFrom[0]).toContain('providers.json');
  });
});

describe('provider detection', () => {
  it('prefers the request url, which is present whenever capture was used', () => {
    const detection = detectProvider(bundled.table, { messages: [] }, 'https://api.anthropic.com/v1/messages');
    expect(detection.provider).toBe('anthropic');
    expect(detection.basis).toContain('url');
  });

  it('falls back to the model identifier when there is no url', () => {
    expect(detectProvider(bundled.table, { model: 'claude-opus-5', messages: [] }).provider).toBe('anthropic');
    expect(detectProvider(bundled.table, { model: 'gpt-4o', messages: [] }).provider).toBe('openai');
  });

  it('treats an unrecognised model on a shared wire shape as a generic endpoint', () => {
    const detection = detectProvider(bundled.table, { model: 'llama-3.3-70b', messages: [] });
    expect(detection.provider).toBe('openai-compatible');
  });

  it('says what it cannot determine rather than picking one', () => {
    expect(() => detectProvider({ ...bundled.table, providers: {
      a: { ...bundled.table.providers['anthropic']!, detect: { bodyRequires: ['messages'], priority: 1 } },
      b: { ...bundled.table.providers['openai']!, detect: { bodyRequires: ['messages'], priority: 2 } },
    } }, { messages: [] })).toThrow(AmbiguousProviderError);
  });
});

describe('request adapters', () => {
  it('orders blocks the way the provider hashes them', () => {
    const parsed = anthropicAdapter.parse(
      {
        model: 'claude-sonnet-4-5',
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
        system: 'you are a support agent',
        messages: [{ role: 'user', content: 'hello' }],
      },
      { fidelity: 'builder' },
    );
    expect(parsed.blocks.map((block) => block.kind)).toEqual(['tools', 'system', 'message']);
  });

  it('finds a cache boundary wherever the request declares one', () => {
    const parsed = anthropicAdapter.parse(
      {
        model: 'claude-sonnet-4-5',
        system: [
          { type: 'text', text: 'stable' },
          { type: 'text', text: 'also stable', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      },
      { fidelity: 'builder' },
    );
    expect(parsed.blocks[0]?.cacheMarker).toBeUndefined();
    expect(parsed.blocks[1]?.cacheMarker?.ttl).toBe('1h');
  });

  it('canonicalises tool schemas so registry ordering inside a schema cannot change the bytes', () => {
    const one = anthropicAdapter.parse(
      { model: 'm', tools: [{ name: 'a', input_schema: { type: 'object', properties: { x: {}, y: {} } } }], messages: [] },
      { fidelity: 'builder' },
    );
    const two = anthropicAdapter.parse(
      { model: 'm', tools: [{ input_schema: { properties: { y: {}, x: {} }, type: 'object' }, name: 'a' }], messages: [] },
      { fidelity: 'builder' },
    );
    expect(one.blocks[0]?.parts).toEqual(two.blocks[0]?.parts);
  });

  it('keeps tool array order, because that order is content', () => {
    const forward = anthropicAdapter.parse({ model: 'm', tools: [{ name: 'a' }, { name: 'b' }], messages: [] }, { fidelity: 'builder' });
    const reverse = anthropicAdapter.parse({ model: 'm', tools: [{ name: 'b' }, { name: 'a' }], messages: [] }, { fidelity: 'builder' });
    expect(forward.blocks[0]?.parts).not.toEqual(reverse.blocks[0]?.parts);
  });

  it('reads a routing key into scope when the request sets one', () => {
    const parsed = openaiAdapter.parse(
      { model: 'gpt-4o', prompt_cache_key: 'support-v4', messages: [{ role: 'user', content: 'hi' }] },
      { fidelity: 'builder' },
    );
    expect(parsed.scope.routingKey).toBe('support-v4');
  });

  it('treats developer and system roles alike, since both are prompt rather than turn', () => {
    const parsed = openaiAdapter.parse(
      { model: 'gpt-4o', messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }] },
      { fidelity: 'builder' },
    );
    expect(parsed.blocks.map((block) => block.kind)).toEqual(['system', 'message']);
  });
});
