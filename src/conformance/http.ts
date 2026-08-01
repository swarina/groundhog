import { normaliseUsage } from '../audit/ingest.js';
import type { ProviderProfile } from '../types.js';
import type { Sender, SendResult } from './types.js';

/**
 * The real sender.
 *
 * This is the one place in the tool that makes an outbound request to a
 * provider, and it exists only for a conformance run the user asked for. It
 * posts a probe body to the provider's completion endpoint, reads the usage
 * from the response, and normalises it the same way the audit does.
 */

interface Endpoint {
  url: string;
  headers(apiKey: string): Record<string, string>;
}

const ENDPOINTS: Record<string, Endpoint> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (apiKey) => ({ 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  },
};

export class ConformanceRequestError extends Error {
  constructor(status: number, body: string) {
    super(`The provider rejected a probe request with status ${status}: ${body.slice(0, 200)}`);
    this.name = 'ConformanceRequestError';
  }
}

function usageField(response: unknown): unknown {
  return response && typeof response === 'object' ? (response as Record<string, unknown>)['usage'] : undefined;
}

export function httpSender(profile: ProviderProfile, apiKey: string): Sender {
  const endpoint = ENDPOINTS[profile.id];
  if (!endpoint) throw new Error(`No conformance endpoint for provider "${profile.id}".`);

  return async (body: unknown): Promise<SendResult> => {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: endpoint.headers(apiKey),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new ConformanceRequestError(response.status, text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConformanceRequestError(response.status, 'the response was not json');
    }
    return { usage: normaliseUsage(usageField(parsed), profile.usageFields) };
  };
}
