import { inspectRequest, type InspectOptions } from '../engine/inspect.js';
import type { Report } from '../types.js';

/**
 * Test time request capture.
 *
 * This is the accurate place to measure. A prompt builder returns one thing and
 * the sdk sends another, after it normalises content shapes, injects defaults
 * and serialises. The provider hashes what was sent, so that is what has to be
 * inspected. Capturing at fetch means an application whose request is assembled
 * across a framework, some middleware and a retriever needs no refactoring to
 * be checked.
 *
 * Nothing here belongs in a production path. It patches the global fetch, and
 * by default it does not send anything, so tests need no keys, cost nothing and
 * make no network calls.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  /** Byte length of the serialised body, which is what the provider receives. */
  wireBytes: number;
  /** Milliseconds since the recorder started, not wall clock, so runs compare. */
  atMs: number;
}

export interface CaptureOptions {
  /**
   * 'intercept' answers with a minimal valid response and sends nothing.
   * 'passthrough' forwards to the real endpoint and records on the way.
   */
  mode?: 'intercept' | 'passthrough';
  /** Decides which requests are captured. Defaults to the usual completion paths. */
  match?: (url: string) => boolean;
}

export interface Recorder {
  requests(): CapturedRequest[];
  /** One report per captured request. Throws when nothing was captured. */
  inspect(options?: InspectOptions): Report[];
  clear(): void;
  restore(): void;
}

export class NothingCapturedError extends Error {
  constructor(matcher: string) {
    super(
      'No requests were captured, so there is nothing to check.\n' +
        `The recorder was listening for urls matching ${matcher}.\n` +
        'Make sure the code under test ran and that it uses global fetch. ' +
        'If your client uses its own http agent, pass a match function or capture at that client instead.\n' +
        'This is reported as an error rather than a pass, because a check that inspected nothing has not verified anything.',
    );
    this.name = 'NothingCapturedError';
  }
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const DEFAULT_PATHS = ['/v1/messages', '/chat/completions', '/v1/responses', '/v1/complete'];

function defaultMatch(url: string): boolean {
  return DEFAULT_PATHS.some((path) => url.includes(path));
}

function stubResponse(url: string, body: unknown): Response {
  const model = (body as Record<string, unknown> | null)?.['model'];
  const modelId = typeof model === 'string' ? model : 'unknown';

  // Shaped enough that a client can parse it and the code under test can carry
  // on. Never used for anything other than letting the caller proceed.
  const payload = url.includes('/v1/messages')
    ? {
        id: 'msg_groundhog_stub',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [{ type: 'text', text: '' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    : {
        id: 'chatcmpl-groundhog-stub',
        object: 'chat.completion',
        model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
      };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function bodyOf(input: FetchInput, init?: FetchInit): Promise<string | null> {
  if (init?.body != null) {
    if (typeof init.body === 'string') return init.body;
    if (init.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8');
  }
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  }
  return null;
}

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function capture(options: CaptureOptions = {}): Recorder {
  const mode = options.mode ?? 'intercept';
  const match = options.match ?? defaultMatch;
  const matcherLabel = options.match ? 'a custom match function' : DEFAULT_PATHS.join(', ');

  const original = globalThis.fetch;
  if (typeof original !== 'function') {
    throw new Error('Global fetch is not available, so requests cannot be captured. Node 20 or newer is required.');
  }

  const captured: CapturedRequest[] = [];
  const startedAt = Date.now();
  let restored = false;

  const patched: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    if (!match(url)) return original(input, init);

    const raw = await bodyOf(input, init);
    if (raw != null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed != null) {
        captured.push({
          url,
          method: (init?.method ?? (input instanceof Request ? input.method : 'POST')).toUpperCase(),
          body: parsed,
          wireBytes: Buffer.byteLength(raw, 'utf8'),
          atMs: Date.now() - startedAt,
        });
      }
    }

    if (mode === 'passthrough') return original(input, init);
    return stubResponse(url, captured[captured.length - 1]?.body ?? null);
  };

  globalThis.fetch = patched;

  return {
    requests: () => [...captured],

    inspect(inspectOptions: InspectOptions = {}): Report[] {
      if (captured.length === 0) throw new NothingCapturedError(matcherLabel);
      return captured.map((request) =>
        inspectRequest(request.body, {
          ...inspectOptions,
          url: request.url,
          fidelity: 'wire',
          wireBytes: request.wireBytes,
        }),
      );
    },

    clear: () => {
      captured.length = 0;
    },

    restore: () => {
      if (restored) return;
      restored = true;
      globalThis.fetch = original;
    },
  };
}
