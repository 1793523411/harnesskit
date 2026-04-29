import type { ProviderImpl } from '../types.js';
import { applyDenyRewrites } from './deny.js';
import { detectOpenAIResponses } from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeOpenAIResponsesStream } from './stream.js';
import type { ResponsesRequest, ResponsesResponse } from './types.js';

const isResponsesShape = (body: unknown): body is ResponsesRequest =>
  !!body && typeof body === 'object' && 'model' in body && 'input' in body;

export const openaiResponsesProvider: ProviderImpl = {
  tag: 'openai-responses',
  detect: (input, init, opts) =>
    detectOpenAIResponses(input, init, { customHosts: opts.customHosts?.openai ?? [] }),
  parseRequest: (body, _ctx) => (isResponsesShape(body) ? body : undefined),
  applyDeny: (req, denied) => applyDenyRewrites(req as ResponsesRequest, denied),
  serializeRequest: (req) => JSON.stringify(req),
  isStreamRequest: (req) => (req as ResponsesRequest).stream === true,
  getModel: (req) => (req as ResponsesRequest).model,
  normalizeRequest: (req) => normalizeRequest(req as ResponsesRequest),
  consumeStream: consumeOpenAIResponsesStream,
  parseResponseText: (text) => {
    try {
      return JSON.parse(text) as ResponsesResponse;
    } catch {
      return undefined;
    }
  },
  normalizeResponse: (res) => normalizeResponse(res as ResponsesResponse),
  extractToolCalls: (res) => extractToolCalls(res as ResponsesResponse),
  extractUsage: (res) => extractUsage((res as ResponsesResponse).usage),
};
