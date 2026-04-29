import type { ProviderImpl } from '../types.js';
import { applyContentRewrites, applyDenyRewrites } from './deny.js';
import { detectOpenAIChat, detectOpenRouter } from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeOpenAIStream } from './stream.js';
import type { OpenAIRequest, OpenAIResponse } from './types.js';

const isOpenAIShape = (body: unknown): body is OpenAIRequest =>
  !!body &&
  typeof body === 'object' &&
  'model' in body &&
  'messages' in body &&
  Array.isArray((body as { messages: unknown }).messages);

const sharedImpl = {
  parseRequest: (body: unknown, _ctx: { url: URL }) => (isOpenAIShape(body) ? body : undefined),
  applyDeny: (req: unknown, denied: ReadonlyMap<string, string>) =>
    applyDenyRewrites(req as OpenAIRequest, denied),
  serializeRequest: (req: unknown) => JSON.stringify(req),
  isStreamRequest: (req: unknown) => (req as OpenAIRequest).stream === true,
  getModel: (req: unknown) => (req as OpenAIRequest).model,
  normalizeRequest: (req: unknown) => normalizeRequest(req as OpenAIRequest),
  consumeStream: consumeOpenAIStream,
  parseResponseText: (text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { choices?: unknown }).choices)
    ) {
      return undefined;
    }
    return parsed as OpenAIResponse;
  },
  normalizeResponse: (res: unknown) => normalizeResponse(res as OpenAIResponse),
  extractToolCalls: (res: unknown) => extractToolCalls(res as OpenAIResponse),
  extractUsage: (res: unknown) => extractUsage((res as OpenAIResponse).usage),
  applyContentRewrites: (
    req: unknown,
    rewriter: import('../types.js').ToolResultRewriter,
  ) => applyContentRewrites(req as OpenAIRequest, rewriter),
};

export const openaiProvider: ProviderImpl = {
  ...sharedImpl,
  tag: 'openai',
  detect: (input, init, opts) =>
    detectOpenAIChat(input, init, { customHosts: opts.customHosts?.openai ?? [] }),
};

export const openrouterProvider: ProviderImpl = {
  ...sharedImpl,
  tag: 'openrouter',
  detect: (input, init, opts) =>
    detectOpenRouter(input, init, { customHosts: opts.customHosts?.openrouter ?? [] }),
};
