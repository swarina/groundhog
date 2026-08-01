import { canonicalJson } from '../../core/canonical.js';
import { sha256 } from '../../core/hash.js';
import type { Block, CanonicalRequest, Part } from '../../types.js';
import type { ProviderAdapter } from '../types.js';

/**
 * This provider caches automatically with no boundary control surface, so no
 * block ever carries a cache marker. What matters instead is how much of the
 * prompt is genuinely shared between requests, and whether requests reach the
 * same backend.
 */

function partsFromContent(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'json', canonical: canonicalJson(content) }];

  const parts: Part[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      parts.push({ type: 'text', text: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object') {
      parts.push({ type: 'json', canonical: canonicalJson(raw) });
      continue;
    }
    const element = raw as Record<string, unknown>;
    const type = element['type'];
    if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof element['text'] === 'string') {
      parts.push({ type: 'text', text: element['text'] });
    } else if (type === 'image_url' || type === 'input_image') {
      const url = element['image_url'] ?? element['url'] ?? element;
      const serialised = typeof url === 'string' ? url : canonicalJson(url);
      parts.push({
        type: 'binary',
        sha256: sha256(serialised),
        byteLength: Buffer.byteLength(serialised, 'utf8'),
        mime: 'image/*',
      });
    } else {
      parts.push({ type: 'json', canonical: canonicalJson(element) });
    }
  }
  return parts;
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',

  parse(rawBody, context): CanonicalRequest {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const blocks: Block[] = [];
    let next = 0;

    const tools = body['tools'];
    if (Array.isArray(tools) && tools.length > 0) {
      blocks.push({
        index: next++,
        kind: 'tools',
        parts: tools.map((tool) => ({ type: 'json', canonical: canonicalJson(tool) }) satisfies Part),
      });
    }

    // Both the chat completions shape and the responses shape are accepted.
    const instructions = body['instructions'];
    if (typeof instructions === 'string' && instructions.length > 0) {
      blocks.push({ index: next++, kind: 'system', role: 'system', parts: [{ type: 'text', text: instructions }] });
    }

    const messages = Array.isArray(body['messages'])
      ? (body['messages'] as unknown[])
      : Array.isArray(body['input'])
        ? (body['input'] as unknown[])
        : [];

    for (const raw of messages) {
      if (typeof raw === 'string') {
        blocks.push({ index: next++, kind: 'message', role: 'user', parts: [{ type: 'text', text: raw }] });
        continue;
      }
      const message = (raw ?? {}) as Record<string, unknown>;
      const rawRole = typeof message['role'] === 'string' ? message['role'] : 'user';
      const isSystem = rawRole === 'system' || rawRole === 'developer';
      const parts = partsFromContent(message['content']);
      blocks.push({
        index: next++,
        kind: isSystem ? 'system' : 'message',
        role: isSystem ? 'system' : rawRole === 'assistant' ? 'assistant' : 'user',
        parts,
      });
    }

    const model = context.model ?? (typeof body['model'] === 'string' ? body['model'] : '');
    const routingKey = body['prompt_cache_key'];

    return {
      provider: 'openai',
      model,
      blocks,
      scope: {
        model,
        ...(typeof routingKey === 'string' ? { routingKey } : {}),
        ...(body['tool_choice'] ? { toolChoice: canonicalJson(body['tool_choice']) } : {}),
        ...(body['response_format'] ? { responseFormat: canonicalJson(body['response_format']) } : {}),
      },
      fidelity: context.fidelity,
      ...(context.wireBytes != null ? { wireBytes: context.wireBytes } : {}),
    };
  },
};

/**
 * Endpoints that speak the same wire shape but whose caching behaviour is not
 * known. The parse is identical, only the provider identity differs, which is
 * what makes every threshold check skip rather than run on a borrowed value.
 */
export const openaiCompatibleAdapter: ProviderAdapter = {
  id: 'openai-compatible',
  parse(body, context) {
    return { ...openaiAdapter.parse(body, context), provider: 'openai-compatible' };
  },
};
