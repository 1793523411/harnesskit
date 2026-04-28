import type { ProviderImpl } from '../types.js';
import { applyDenyRewrites } from './deny.js';
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
  parseRequest: (body: unknown) => (isOpenAIShape(body) ? body : undefined),
  applyDeny: (req: unknown, denied: ReadonlyMap<string, string>) =>
    applyDenyRewrites(req as OpenAIRequest, denied),
  serializeRequest: (req: unknown) => JSON.stringify(req),
  isStreamRequest: (req: unknown) => (req as OpenAIRequest).stream === true,
  getModel: (req: unknown) => (req as OpenAIRequest).model,
  normalizeRequest: (req: unknown) => normalizeRequest(req as OpenAIRequest),
  consumeStream: consumeOpenAIStream,
  parseResponseText: (text: string) => {
    try {
      return JSON.parse(text) as OpenAIResponse;
    } catch {
      return undefined;
    }
  },
  normalizeResponse: (res: unknown) => normalizeResponse(res as OpenAIResponse),
  extractToolCalls: (res: unknown) => extractToolCalls(res as OpenAIResponse),
  extractUsage: (res: unknown) => extractUsage((res as OpenAIResponse).usage),
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
