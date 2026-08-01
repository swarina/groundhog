import type { RequestShaper } from './probes.js';

/**
 * Provider specific request shapes for the probes.
 *
 * The probes control what goes in the cacheable prefix; the shaper knows how to
 * put it there for a given provider. Anthropic marks a boundary explicitly,
 * OpenAI caches the whole prefix automatically, so the shapes differ while the
 * probe logic does not.
 */

function tool(name: string): unknown {
  return { name, description: `the ${name} does a thing`, input_schema: { type: 'object', properties: {} } };
}

export function anthropicShaper(model: string): RequestShaper {
  return {
    withPrefix(text) {
      return {
        model,
        max_tokens: 16,
        system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'ok' }],
      };
    },
    withTools(toolNames) {
      const tools = toolNames.map(tool);
      const last = tools[tools.length - 1] as Record<string, unknown>;
      // The boundary goes on the last tool, so the whole tool list is the span.
      last['cache_control'] = { type: 'ephemeral' };
      return { model, max_tokens: 16, tools, messages: [{ role: 'user', content: 'ok' }] };
    },
  };
}

export function openaiShaper(model: string): RequestShaper {
  return {
    withPrefix(text) {
      return { model, max_tokens: 16, messages: [{ role: 'system', content: text }, { role: 'user', content: 'ok' }] };
    },
    withTools(toolNames) {
      const tools = toolNames.map((name) => ({ type: 'function', function: tool(name) }));
      return { model, max_tokens: 16, tools, messages: [{ role: 'user', content: 'ok' }] };
    },
  };
}

export function shaperFor(provider: string, model: string): RequestShaper {
  if (provider === 'anthropic') return anthropicShaper(model);
  if (provider === 'openai' || provider === 'openai-compatible') return openaiShaper(model);
  throw new Error(`No conformance shaper for provider "${provider}".`);
}
