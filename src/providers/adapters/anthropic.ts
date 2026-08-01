import { canonicalJson } from '../../core/canonical.js';
import { sha256 } from '../../core/hash.js';
import type { Block, CacheMarker, CanonicalRequest, Part } from '../../types.js';
import type { ProviderAdapter } from '../types.js';

/**
 * Blocks are emitted in the order this provider hashes them: tool definitions
 * first, then the system section, then the message list. A change in an earlier
 * section invalidates everything after it, so block order is the order in which
 * a divergence propagates.
 */

interface Ctx {
  blocks: Block[];
  next: number;
}

function push(ctx: Ctx, block: Omit<Block, 'index'>): void {
  ctx.blocks.push({ ...block, index: ctx.next });
  ctx.next += 1;
}

function markerOf(element: Record<string, unknown>): CacheMarker | undefined {
  const control = element['cache_control'];
  if (!control || typeof control !== 'object') return undefined;
  const ttl = (control as Record<string, unknown>)['ttl'];
  return typeof ttl === 'string' ? { ttl } : {};
}

function partsFromContent(content: unknown): { parts: Part[]; marker?: CacheMarker } {
  if (typeof content === 'string') return { parts: [{ type: 'text', text: content }] };
  if (!Array.isArray(content)) return { parts: [{ type: 'json', canonical: canonicalJson(content) }] };

  const parts: Part[] = [];
  let marker: CacheMarker | undefined;

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
    marker = markerOf(element) ?? marker;

    const type = element['type'];
    if (type === 'text' && typeof element['text'] === 'string') {
      parts.push({ type: 'text', text: element['text'] });
    } else if (type === 'image' || type === 'document') {
      parts.push(binaryPart(element));
    } else if (type === 'tool_result') {
      // The envelope identifies the call, the inner content is the payload that
      // actually varies. Both are kept so a change in either is localisable.
      const { content: inner, cache_control: _ignored, ...envelope } = element;
      parts.push({ type: 'json', canonical: canonicalJson(envelope) });
      parts.push(...partsFromContent(inner).parts);
    } else {
      const { cache_control: _ignored, ...rest } = element;
      parts.push({ type: 'json', canonical: canonicalJson(rest) });
    }
  }

  return marker ? { parts, marker } : { parts };
}

function binaryPart(element: Record<string, unknown>): Part {
  const source = element['source'];
  const src = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
  const data = typeof src['data'] === 'string' ? src['data'] : canonicalJson(source);
  const mime = typeof src['media_type'] === 'string' ? src['media_type'] : 'application/octet-stream';
  return {
    type: 'binary',
    sha256: sha256(data),
    byteLength: Buffer.byteLength(data, 'utf8'),
    mime,
  };
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  parse(rawBody, context): CanonicalRequest {
    const body = (rawBody ?? {}) as Record<string, unknown>;
    const ctx: Ctx = { blocks: [], next: 0 };

    const tools = body['tools'];
    if (Array.isArray(tools) && tools.length > 0) {
      let marker: CacheMarker | undefined;
      const parts: Part[] = tools.map((tool) => {
        if (tool && typeof tool === 'object') {
          const element = tool as Record<string, unknown>;
          marker = markerOf(element) ?? marker;
          const { cache_control: _ignored, ...rest } = element;
          return { type: 'json', canonical: canonicalJson(rest) } satisfies Part;
        }
        return { type: 'json', canonical: canonicalJson(tool) } satisfies Part;
      });
      push(ctx, marker ? { kind: 'tools', parts, cacheMarker: marker } : { kind: 'tools', parts });
    }

    const system = body['system'];
    if (typeof system === 'string' && system.length > 0) {
      push(ctx, { kind: 'system', role: 'system', parts: [{ type: 'text', text: system }] });
    } else if (Array.isArray(system)) {
      for (const element of system) {
        const { parts, marker } = partsFromContent([element]);
        push(ctx, marker ? { kind: 'system', role: 'system', parts, cacheMarker: marker } : { kind: 'system', role: 'system', parts });
      }
    }

    const messages = body['messages'];
    if (Array.isArray(messages)) {
      for (const raw of messages) {
        const message = (raw ?? {}) as Record<string, unknown>;
        const role = message['role'] === 'assistant' ? 'assistant' : 'user';
        const { parts, marker } = partsFromContent(message['content']);
        push(ctx, marker ? { kind: 'message', role, parts, cacheMarker: marker } : { kind: 'message', role, parts });
      }
    }

    const model = context.model ?? (typeof body['model'] === 'string' ? body['model'] : '');

    return {
      provider: 'anthropic',
      model,
      blocks: ctx.blocks,
      scope: {
        model,
        ...(body['tool_choice'] ? { toolChoice: canonicalJson(body['tool_choice']) } : {}),
      },
      fidelity: context.fidelity,
      ...(context.wireBytes != null ? { wireBytes: context.wireBytes } : {}),
    };
  },
};
