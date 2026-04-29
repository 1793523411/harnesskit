import type { ToolCall } from '@harnesskit/core';
import { type SseEvent, parseSseStream } from '../../sse.js';
import type { ConsumeStreamOpts } from '../types.js';
import type { AnthropicContentBlock, AnthropicResponse, AnthropicUsage } from './types.js';

interface AccumState {
  messageId?: string;
  model?: string;
  blocks: AnthropicContentBlock[];
  toolJsonParts: Map<number, string>;
  stopReason?: string;
  usage?: AnthropicUsage;
}

const createAccum = (): AccumState => ({
  blocks: [],
  toolJsonParts: new Map(),
});

interface AnyJson {
  [key: string]: unknown;
}

const safeParse = (s: string): AnyJson | undefined => {
  try {
    return JSON.parse(s) as AnyJson;
  } catch {
    return undefined;
  }
};

/**
 * Mutates `accum` in place. Returns the assembled tool_use call (if any) when
 * a content_block_stop arrives for a tool_use index — caller can fire the
 * eager onToolCall hook there.
 */
const processEvent = (ev: SseEvent, accum: AccumState): { completedToolCall?: ToolCall } => {
  const data = safeParse(ev.data);
  if (!data) return {};

  switch (ev.event) {
    case 'message_start': {
      const msg = data.message as AnyJson | undefined;
      if (msg) {
        if (typeof msg.id === 'string') accum.messageId = msg.id;
        if (typeof msg.model === 'string') accum.model = msg.model;
        const usage = msg.usage as AnthropicUsage | undefined;
        if (usage) accum.usage = usage;
      }
      return {};
    }
    case 'content_block_start': {
      const idx = data.index as number | undefined;
      const block = data.content_block as AnthropicContentBlock | undefined;
      if (idx === undefined || !block) return {};
      accum.blocks[idx] = block;
      if (block.type === 'tool_use') accum.toolJsonParts.set(idx, '');
      return {};
    }
    case 'content_block_delta': {
      const idx = data.index as number | undefined;
      const delta = data.delta as AnyJson | undefined;
      if (idx === undefined || !delta) return {};
      const block = accum.blocks[idx];
      if (!block) return {};
      const dtype = delta.type;
      if (dtype === 'text_delta' && block.type === 'text') {
        block.text += String(delta.text ?? '');
      } else if (dtype === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += String(delta.thinking ?? '');
      } else if (dtype === 'input_json_delta' && block.type === 'tool_use') {
        const cur = accum.toolJsonParts.get(idx) ?? '';
        accum.toolJsonParts.set(idx, cur + String(delta.partial_json ?? ''));
      }
      return {};
    }
    case 'content_block_stop': {
      const idx = data.index as number | undefined;
      if (idx === undefined) return {};
      const block = accum.blocks[idx];
      if (block?.type === 'tool_use') {
        const json = accum.toolJsonParts.get(idx) ?? '';
        block.input = json ? (safeParse(json) ?? {}) : {};
        return {
          completedToolCall: { id: block.id, name: block.name, input: block.input },
        };
      }
      return {};
    }
    case 'message_delta': {
      const delta = data.delta as AnyJson | undefined;
      if (delta && typeof delta.stop_reason === 'string') {
        accum.stopReason = delta.stop_reason;
      }
      const usage = data.usage as AnthropicUsage | undefined;
      if (usage) accum.usage = { ...accum.usage, ...usage };
      return {};
    }
  }
  return {};
};

export interface StreamProcessResult {
  response: AnthropicResponse;
  errored: Error | undefined;
  eagerlyEmittedCallIds?: string[];
  aborted?: boolean;
}

/**
 * Consumes an SSE byte stream and returns the assembled AnthropicResponse.
 * Caller is responsible for tee-ing the original body.
 *
 * If `opts.onToolCall` is provided, eagerly fires it as soon as each tool_use
 * block completes (content_block_stop). If the callback returns `{abort:true}`,
 * the consumer stops reading immediately so the caller can cancel upstream.
 */
export const consumeAnthropicStream = async (
  stream: ReadableStream<Uint8Array>,
  opts?: ConsumeStreamOpts,
): Promise<StreamProcessResult> => {
  const accum = createAccum();
  const eagerlyEmittedCallIds: string[] = [];
  let aborted = false;
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const { completedToolCall } = processEvent(value, accum);
      if (completedToolCall && opts?.onToolCall) {
        eagerlyEmittedCallIds.push(completedToolCall.id);
        const decision = await opts.onToolCall(completedToolCall);
        if (decision.abort) {
          aborted = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  const response: AnthropicResponse = {
    id: accum.messageId ?? 'unknown',
    type: 'message',
    role: 'assistant',
    model: accum.model ?? 'unknown',
    content: accum.blocks.filter((b): b is AnthropicContentBlock => b !== undefined),
  };
  if (accum.stopReason !== undefined) response.stop_reason = accum.stopReason;
  if (accum.usage !== undefined) response.usage = accum.usage;
  const out: StreamProcessResult = { response, errored };
  if (eagerlyEmittedCallIds.length > 0) out.eagerlyEmittedCallIds = eagerlyEmittedCallIds;
  if (aborted) out.aborted = true;
  return out;
};
