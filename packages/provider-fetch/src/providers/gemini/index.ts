import type { ProviderImpl } from '../types.js';
import { applyContentRewrites, applyDenyRewrites } from './deny.js';
import { detectGemini, extractGeminiModelFromPath, isStreamPath } from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeGeminiStream } from './stream.js';
import type { GeminiRequest, GeminiResponse } from './types.js';

const isGeminiShape = (body: unknown): body is GeminiRequest =>
  !!body && typeof body === 'object' && Array.isArray((body as { contents?: unknown }).contents);

export const geminiProvider: ProviderImpl = {
  tag: 'google',
  detect: (input, init, opts) =>
    detectGemini(input, init, { customHosts: opts.customHosts?.google ?? [] }),
  parseRequest: (body, ctx) => {
    if (!isGeminiShape(body)) return undefined;
    const model = extractGeminiModelFromPath(ctx.url.pathname);
    return {
      ...body,
      _harnessModel: model,
      _harnessStream: isStreamPath(ctx.url.pathname),
    } as GeminiRequest;
  },
  applyDeny: (req, denied) => applyDenyRewrites(req as GeminiRequest, denied),
  serializeRequest: (req) => {
    const { _harnessModel, _harnessStream, ...rest } = req as GeminiRequest & {
      _harnessModel?: string;
      _harnessStream?: boolean;
    };
    return JSON.stringify(rest);
  },
  isStreamRequest: (req) => (req as GeminiRequest)._harnessStream === true,
  getModel: (req) => (req as GeminiRequest)._harnessModel ?? 'unknown',
  normalizeRequest: (req) => normalizeRequest(req as GeminiRequest),
  consumeStream: consumeGeminiStream,
  parseResponseText: (text) => {
    try {
      return JSON.parse(text) as GeminiResponse;
    } catch {
      return undefined;
    }
  },
  normalizeResponse: (res) => normalizeResponse(res as GeminiResponse),
  extractToolCalls: (res) => extractToolCalls(res as GeminiResponse),
  extractUsage: (res) => extractUsage((res as GeminiResponse).usageMetadata),
  applyContentRewrites: (req, rewriter) => applyContentRewrites(req as GeminiRequest, rewriter),
};
