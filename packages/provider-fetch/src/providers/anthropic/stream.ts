import { type SseEvent, parseSseStream } from '../../sse.js';
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

const processEvent = (ev: SseEvent, accum: AccumState): void => {
  const data = safeParse(ev.data);
  if (!data) return;

  switch (ev.event) {
    case 'message_start': {
      const msg = data.message as AnyJson | undefined;
      if (msg) {
        if (typeof msg.id === 'string') accum.messageId = msg.id;
        if (typeof msg.model === 'string') accum.model = msg.model;
        const usage = msg.usage as AnthropicUsage | undefined;
        if (usage) accum.usage = usage;
      }
      break;
    }
    case 'content_block_start': {
      const idx = data.index as number | undefined;
      const block = data.content_block as AnthropicContentBlock | undefined;
      if (idx === undefined || !block) break;
      accum.blocks[idx] = block;
      if (block.type === 'tool_use') accum.toolJsonParts.set(idx, '');
      break;
    }
    case 'content_block_delta': {
      const idx = data.index as number | undefined;
      const delta = data.delta as AnyJson | undefined;
      if (idx === undefined || !delta) break;
      const block = accum.blocks[idx];
      if (!block) break;
      const dtype = delta.type;
      if (dtype === 'text_delta' && block.type === 'text') {
        block.text += String(delta.text ?? '');
      } else if (dtype === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += String(delta.thinking ?? '');
      } else if (dtype === 'input_json_delta' && block.type === 'tool_use') {
        const cur = accum.toolJsonParts.get(idx) ?? '';
        accum.toolJsonParts.set(idx, cur + String(delta.partial_json ?? ''));
      }
      break;
    }
    case 'content_block_stop': {
      const idx = data.index as number | undefined;
      if (idx === undefined) break;
      const block = accum.blocks[idx];
      if (block?.type === 'tool_use') {
        const json = accum.toolJsonParts.get(idx) ?? '';
        block.input = json ? (safeParse(json) ?? {}) : {};
      }
      break;
    }
    case 'message_delta': {
      const delta = data.delta as AnyJson | undefined;
      if (delta && typeof delta.stop_reason === 'string') {
        accum.stopReason = delta.stop_reason;
      }
      const usage = data.usage as AnthropicUsage | undefined;
      if (usage) accum.usage = { ...accum.usage, ...usage };
      break;
    }
  }
};

export interface StreamProcessResult {
  response: AnthropicResponse;
  errored: Error | undefined;
}

/**
 * Consumes an SSE byte stream and returns the assembled AnthropicResponse.
 * Caller is responsible for tee-ing the original body.
 */
export const consumeAnthropicStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<StreamProcessResult> => {
  const accum = createAccum();
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      processEvent(value, accum);
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
  return { response, errored };
};
