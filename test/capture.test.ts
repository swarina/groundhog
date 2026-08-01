import { afterEach, describe, expect, it } from 'vitest';
import { capture, NothingCapturedError, type Recorder } from '../src/capture/index.js';

let active: Recorder | null = null;

afterEach(() => {
  active?.restore();
  active = null;
});

const BODY = {
  model: 'claude-sonnet-4-5',
  max_tokens: 256,
  system: [{ type: 'text', text: 'you are a support agent', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'where is my order' }],
};

async function send(body: unknown = BODY, url = 'https://api.anthropic.com/v1/messages'): Promise<Response> {
  return fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

describe('request capture', () => {
  it('records what was sent without making a network call', async () => {
    active = capture();
    const response = await send();

    expect(response.ok).toBe(true);
    expect(active.requests()).toHaveLength(1);
    expect(active.requests()[0]?.body).toEqual(BODY);
  });

  it('answers with something the calling code can parse and carry on with', async () => {
    active = capture();
    const parsed = (await (await send()).json()) as { content: unknown[]; model: string };
    expect(parsed.model).toBe('claude-sonnet-4-5');
    expect(Array.isArray(parsed.content)).toBe(true);
  });

  it('records the byte length that was actually serialised', async () => {
    active = capture();
    await send();
    expect(active.requests()[0]?.wireBytes).toBe(Buffer.byteLength(JSON.stringify(BODY), 'utf8'));
  });

  it('ignores traffic that is not a completion request', async () => {
    active = capture();
    const untouched: string[] = [];
    const previous = globalThis.fetch;
    // Anything the matcher rejects reaches the original fetch, which is stubbed
    // here so the test makes no real request either way.
    globalThis.fetch = (async (input: unknown) => {
      untouched.push(String(input));
      return new Response('{}');
    }) as typeof fetch;
    const recorder = capture();
    await fetch('https://example.com/health');
    recorder.restore();
    globalThis.fetch = previous;

    expect(untouched).toEqual(['https://example.com/health']);
    expect(recorder.requests()).toHaveLength(0);
  });

  it('marks captured requests as measured at the wire', async () => {
    active = capture();
    await send();
    const [report] = active.inspect({ discover: false });
    expect(report?.fidelity).toBe('wire');
  });

  it('identifies the provider from the captured url', async () => {
    active = capture();
    await send();
    const [report] = active.inspect({ discover: false });
    expect(report?.provider).toBe('anthropic');
  });

  it('refuses to report a pass when it captured nothing', () => {
    // A capture based check that inspected zero requests has verified nothing.
    // Reporting that as a pass would be the worst possible bug in this tool.
    active = capture();
    expect(() => active?.inspect({ discover: false })).toThrow(NothingCapturedError);
    try {
      active.inspect({ discover: false });
    } catch (error) {
      expect((error as Error).message).toContain('has not verified anything');
    }
  });

  it('puts the original fetch back', async () => {
    const before = globalThis.fetch;
    const recorder = capture();
    expect(globalThis.fetch).not.toBe(before);
    recorder.restore();
    expect(globalThis.fetch).toBe(before);
  });

  it('is safe to restore more than once', () => {
    const before = globalThis.fetch;
    const recorder = capture();
    recorder.restore();
    recorder.restore();
    expect(globalThis.fetch).toBe(before);
  });
});
