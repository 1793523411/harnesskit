import type { ProviderImpl } from '../types.js';
import { applyContentRewrites, applyDenyRewrites } from './deny.js';
import { detectBedrock, extractBedrockModel, isBedrockStreamPath } from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeBedrockStream } from './stream.js';
import type { BedrockRequest, BedrockResponse } from './types.js';

const isBedrockShape = (body: unknown): body is BedrockRequest =>
  !!body &&
  typeof body === 'object' &&
  'messages' in body &&
  Array.isArray((body as { messages: unknown }).messages);

export const bedrockProvider: ProviderImpl = {
  tag: 'bedrock',
  detect: (input, init, opts) =>
    detectBedrock(input, init, { customHosts: opts.customHosts?.bedrock ?? [] }),
  parseRequest: (body, ctx) => {
    if (!isBedrockShape(body)) return undefined;
    const model = extractBedrockModel(ctx.url.pathname);
    const stream = isBedrockStreamPath(ctx.url.pathname);
    const out: BedrockRequest = { ...body };
    if (model) out._harnessModel = model;
    if (stream) out._harnessStream = true;
    return out;
  },
  applyDeny: (req, denied) => applyDenyRewrites(req as BedrockRequest, denied),
  serializeRequest: (req) => {
    const { _harnessModel, _harnessStream, ...rest } = req as BedrockRequest;
    void _harnessModel;
    void _harnessStream;
    return JSON.stringify(rest);
  },
  isStreamRequest: (req) => (req as BedrockRequest)._harnessStream === true,
  getModel: (req) => (req as BedrockRequest)._harnessModel ?? 'unknown',
  normalizeRequest: (req) => normalizeRequest(req as BedrockRequest),
  consumeStream: consumeBedrockStream,
  parseResponseText: (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const r = parsed as { output?: { message?: unknown } };
    if (!r.output?.message) return undefined;
    return parsed as BedrockResponse;
  },
  normalizeResponse: (res) => normalizeResponse(res as BedrockResponse),
  extractToolCalls: (res) => extractToolCalls(res as BedrockResponse),
  extractUsage: (res) => extractUsage((res as BedrockResponse).usage),
  applyContentRewrites: (req, rewriter) => applyContentRewrites(req as BedrockRequest, rewriter),
};
