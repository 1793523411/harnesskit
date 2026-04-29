import type { ProviderImpl } from '../types.js';
import { applyDenyRewrites } from './deny.js';
import { detectAnthropic } from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeAnthropicStream } from './stream.js';
import type { AnthropicRequest, AnthropicResponse } from './types.js';

const isAnthropicShape = (body: unknown): body is AnthropicRequest =>
  !!body &&
  typeof body === 'object' &&
  'model' in body &&
  'messages' in body &&
  Array.isArray((body as { messages: unknown }).messages);

export const anthropicProvider: ProviderImpl = {
  tag: 'anthropic',
  detect: (input, init, opts) =>
    detectAnthropic(input, init, { customHosts: opts.customHosts?.anthropic ?? [] }),
  parseRequest: (body, _ctx) => (isAnthropicShape(body) ? body : undefined),
  applyDeny: (req, denied) => applyDenyRewrites(req as AnthropicRequest, denied),
  serializeRequest: (req) => JSON.stringify(req),
  isStreamRequest: (req) => (req as AnthropicRequest).stream === true,
  getModel: (req) => (req as AnthropicRequest).model,
  normalizeRequest: (req) => normalizeRequest(req as AnthropicRequest),
  consumeStream: consumeAnthropicStream,
  parseResponseText: (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { content?: unknown }).content)
    ) {
      return undefined;
    }
    return parsed as AnthropicResponse;
  },
  normalizeResponse: (res) => normalizeResponse(res as AnthropicResponse),
  extractToolCalls: (res) => extractToolCalls(res as AnthropicResponse),
  extractUsage: (res) => extractUsage((res as AnthropicResponse).usage),
};
