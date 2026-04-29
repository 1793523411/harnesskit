import type { ProviderImpl } from '../types.js';
import { applyContentRewrites, applyDenyRewrites } from './deny.js';
import {
  detectAnthropic,
  extractVertexAnthropicModel,
  isVertexAnthropicStreamPath,
} from './detect.js';
import {
  extractToolCalls,
  extractUsage,
  normalizeRequest,
  normalizeResponse,
} from './normalize.js';
import { consumeAnthropicStream } from './stream.js';
import type { AnthropicRequest, AnthropicResponse } from './types.js';

interface AnthropicRequestEx extends AnthropicRequest {
  /** Internal — set when model came from the Vertex URL path. */
  _harnessModel?: string;
  /** Internal — set when path is :streamRawPredict (Vertex flavor of stream:true). */
  _harnessStreamFromPath?: boolean;
}

const isAnthropicShape = (body: unknown): body is AnthropicRequest =>
  !!body &&
  typeof body === 'object' &&
  'messages' in body &&
  Array.isArray((body as { messages: unknown }).messages);

export const anthropicProvider: ProviderImpl = {
  tag: 'anthropic',
  detect: (input, init, opts) =>
    detectAnthropic(input, init, { customHosts: opts.customHosts?.anthropic ?? [] }),
  parseRequest: (body, ctx) => {
    if (!isAnthropicShape(body)) return undefined;
    // Vertex Claude carries the model in the URL path, not the body.
    const fromPath = extractVertexAnthropicModel(ctx.url.pathname);
    const streamFromPath = isVertexAnthropicStreamPath(ctx.url.pathname);
    if (!fromPath && !streamFromPath) return body;
    const out: AnthropicRequestEx = { ...body };
    if (fromPath && !out.model) out._harnessModel = fromPath;
    if (streamFromPath) out._harnessStreamFromPath = true;
    return out;
  },
  applyDeny: (req, denied) => applyDenyRewrites(req as AnthropicRequest, denied),
  serializeRequest: (req) => {
    const { _harnessModel, _harnessStreamFromPath, ...rest } = req as AnthropicRequestEx;
    void _harnessModel;
    void _harnessStreamFromPath;
    return JSON.stringify(rest);
  },
  isStreamRequest: (req) => {
    const r = req as AnthropicRequestEx;
    return r.stream === true || r._harnessStreamFromPath === true;
  },
  getModel: (req) => {
    const r = req as AnthropicRequestEx;
    return r.model ?? r._harnessModel ?? 'unknown';
  },
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
  applyContentRewrites: (req, rewriter) => applyContentRewrites(req as AnthropicRequest, rewriter),
};
