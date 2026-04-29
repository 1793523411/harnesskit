import type { ToolCall } from '@harnesskit/core';
import type { ConsumeStreamOpts } from '../types.js';
import { readEventStreamFrames } from './eventstream.js';
import type {
  BedrockContentBlock,
  BedrockMessage,
  BedrockResponse,
  BedrockUsage,
} from './types.js';

interface BlockAccum {
  type: 'text' | 'toolUse' | 'unknown';
  text: string[];
  toolUseId?: string;
  toolName?: string;
  toolInputParts: string[];
}

interface AccumState {
  role: 'user' | 'assistant';
  blocks: Map<number, BlockAccum>;
  stopReason?: string;
  usage?: BedrockUsage;
  metricsLatencyMs?: number;
}

const createAccum = (): AccumState => ({
  role: 'assistant',
  blocks: new Map(),
});

const decoder = new TextDecoder();

const safeJson = (s: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

interface Dispatched {
  completedToolCall?: ToolCall;
}

const handleEvent = (
  eventType: string | undefined,
  payload: Record<string, unknown>,
  accum: AccumState,
): Dispatched => {
  switch (eventType) {
    case 'messageStart': {
      const role = (payload.role as 'user' | 'assistant') ?? 'assistant';
      accum.role = role;
      return {};
    }
    case 'contentBlockStart': {
      const idx = payload.contentBlockIndex as number | undefined;
      if (typeof idx !== 'number') return {};
      const start = payload.start as { toolUse?: { toolUseId?: string; name?: string } } | undefined;
      if (start?.toolUse) {
        accum.blocks.set(idx, {
          type: 'toolUse',
          text: [],
          toolUseId: start.toolUse.toolUseId,
          toolName: start.toolUse.name,
          toolInputParts: [],
        });
      } else {
        // Bedrock doesn't always send contentBlockStart for text blocks —
        // delta is the first signal. Pre-create an empty text block here only
        // if we somehow get it explicitly.
        if (!accum.blocks.has(idx)) {
          accum.blocks.set(idx, { type: 'text', text: [], toolInputParts: [] });
        }
      }
      return {};
    }
    case 'contentBlockDelta': {
      const idx = payload.contentBlockIndex as number | undefined;
      const delta = payload.delta as { text?: string; toolUse?: { input?: string } } | undefined;
      if (typeof idx !== 'number' || !delta) return {};
      let block = accum.blocks.get(idx);
      if (!block) {
        block = { type: 'text', text: [], toolInputParts: [] };
        accum.blocks.set(idx, block);
      }
      if (typeof delta.text === 'string') {
        if (block.type === 'unknown') block.type = 'text';
        if (block.type === 'text') block.text.push(delta.text);
      } else if (delta.toolUse?.input !== undefined) {
        if (block.type === 'unknown' || block.type === 'text') block.type = 'toolUse';
        if (block.type === 'toolUse') block.toolInputParts.push(String(delta.toolUse.input));
      }
      return {};
    }
    case 'contentBlockStop': {
      const idx = payload.contentBlockIndex as number | undefined;
      if (typeof idx !== 'number') return {};
      const block = accum.blocks.get(idx);
      if (block?.type === 'toolUse' && block.toolUseId && block.toolName) {
        const input = block.toolInputParts.join('');
        let parsedInput: unknown = {};
        if (input) {
          try {
            parsedInput = JSON.parse(input);
          } catch {
            parsedInput = {};
          }
        }
        return {
          completedToolCall: { id: block.toolUseId, name: block.toolName, input: parsedInput },
        };
      }
      return {};
    }
    case 'messageStop': {
      if (typeof payload.stopReason === 'string') accum.stopReason = payload.stopReason;
      return {};
    }
    case 'metadata': {
      const usage = payload.usage as BedrockUsage | undefined;
      if (usage) accum.usage = usage;
      const metrics = payload.metrics as { latencyMs?: number } | undefined;
      if (typeof metrics?.latencyMs === 'number') accum.metricsLatencyMs = metrics.latencyMs;
      return {};
    }
    default:
      return {};
  }
};

const finalize = (accum: AccumState): BedrockResponse => {
  const indices = [...accum.blocks.keys()].sort((a, b) => a - b);
  const content: BedrockContentBlock[] = [];
  for (const idx of indices) {
    const b = accum.blocks.get(idx);
    if (!b) continue;
    if (b.type === 'text' && b.text.length > 0) {
      content.push({ text: b.text.join('') });
    } else if (b.type === 'toolUse' && b.toolUseId && b.toolName) {
      let input: unknown = {};
      const joined = b.toolInputParts.join('');
      if (joined) {
        try {
          input = JSON.parse(joined);
        } catch {
          input = {};
        }
      }
      content.push({
        toolUse: { toolUseId: b.toolUseId, name: b.toolName, input },
      });
    }
  }
  const message: BedrockMessage = { role: accum.role, content };
  const out: BedrockResponse = { output: { message } };
  if (accum.stopReason !== undefined) out.stopReason = accum.stopReason;
  if (accum.usage !== undefined) out.usage = accum.usage;
  if (accum.metricsLatencyMs !== undefined) out.metrics = { latencyMs: accum.metricsLatencyMs };
  return out;
};

/**
 * Consumes a Bedrock /converse-stream response. The response uses AWS Event
 * Stream binary framing (`application/vnd.amazon.eventstream`). Each frame
 * carries a JSON payload describing a chunk of the assistant message.
 *
 * Mid-stream cancel: when a toolUse content block completes
 * (`contentBlockStop` for a tool block), we fire `onToolCall`. If the policy
 * denies, we abort the stream — same pattern as Anthropic.
 */
export const consumeBedrockStream = async (
  stream: ReadableStream<Uint8Array>,
  opts?: ConsumeStreamOpts,
): Promise<{
  response: BedrockResponse;
  errored: Error | undefined;
  eagerlyEmittedCallIds?: string[];
  aborted?: boolean;
}> => {
  const accum = createAccum();
  const eagerlyEmittedCallIds: string[] = [];
  let aborted = false;
  let errored: Error | undefined;
  try {
    for await (const frame of readEventStreamFrames(stream)) {
      const eventType = frame.headers.get(':event-type');
      const messageType = frame.headers.get(':message-type');
      // Bedrock sometimes returns an `exception` message-type with a payload
      // describing a server error (throttling, validation, etc.).
      if (messageType && messageType !== 'event') {
        const text = decoder.decode(frame.payload);
        const data = safeJson(text);
        const msg =
          (data?.message as string | undefined) ??
          frame.headers.get(':exception-type') ??
          `bedrock returned ${messageType}`;
        errored = new Error(msg);
        break;
      }
      const text = decoder.decode(frame.payload);
      const payload = safeJson(text);
      if (!payload) continue;
      const dispatched = handleEvent(eventType, payload, accum);
      if (dispatched.completedToolCall && opts?.onToolCall) {
        eagerlyEmittedCallIds.push(dispatched.completedToolCall.id);
        const decision = await opts.onToolCall(dispatched.completedToolCall);
        if (decision.abort) {
          aborted = true;
          break;
        }
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  const out: {
    response: BedrockResponse;
    errored: Error | undefined;
    eagerlyEmittedCallIds?: string[];
    aborted?: boolean;
  } = { response: finalize(accum), errored };
  if (eagerlyEmittedCallIds.length > 0) out.eagerlyEmittedCallIds = eagerlyEmittedCallIds;
  if (aborted) out.aborted = true;
  return out;
};
