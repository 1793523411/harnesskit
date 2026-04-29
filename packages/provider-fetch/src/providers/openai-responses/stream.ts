import type { ToolCall } from '@harnesskit/core';
import { parseSseStream } from '../../sse.js';
import type { ConsumeStreamOpts } from '../types.js';
import type {
  ResponsesFunctionCallItem,
  ResponsesItem,
  ResponsesMessageItem,
  ResponsesResponse,
  ResponsesUsage,
} from './types.js';

interface AccumState {
  id?: string;
  model?: string;
  outputItems: Map<number, ResponsesItem>;
  textBuffers: Map<number, string[]>;
  argsBuffers: Map<number, string[]>;
  status?: string;
  usage?: ResponsesUsage;
}

const createAccum = (): AccumState => ({
  outputItems: new Map(),
  textBuffers: new Map(),
  argsBuffers: new Map(),
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

const safeParseArgs = (s: string | undefined): unknown => {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

/**
 * Mutates `accum` in place. When a `response.output_item.done` event arrives
 * for a `function_call` item, returns the assembled tool call so the caller
 * can fire the eager onToolCall hook.
 */
const processEvent = (
  eventName: string | undefined,
  data: AnyJson,
  accum: AccumState,
): { completedToolCall?: ToolCall } => {
  if (!eventName) return {};

  switch (eventName) {
    case 'response.created':
    case 'response.in_progress': {
      const r = data.response as AnyJson | undefined;
      if (r) {
        if (typeof r.id === 'string') accum.id = r.id;
        if (typeof r.model === 'string') accum.model = r.model;
      }
      return {};
    }
    case 'response.output_item.added': {
      const idx = data.output_index as number | undefined;
      const item = data.item as ResponsesItem | undefined;
      if (idx === undefined || !item) return {};
      accum.outputItems.set(idx, structuredClone(item));
      if (item.type === 'message') accum.textBuffers.set(idx, []);
      if (item.type === 'function_call') accum.argsBuffers.set(idx, []);
      return {};
    }
    case 'response.output_text.delta': {
      const idx = data.output_index as number | undefined;
      const delta = data.delta as string | undefined;
      if (idx === undefined || typeof delta !== 'string') return {};
      const buf = accum.textBuffers.get(idx);
      if (buf) buf.push(delta);
      return {};
    }
    case 'response.function_call_arguments.delta': {
      const idx = data.output_index as number | undefined;
      const delta = data.delta as string | undefined;
      if (idx === undefined || typeof delta !== 'string') return {};
      const buf = accum.argsBuffers.get(idx);
      if (buf) buf.push(delta);
      return {};
    }
    case 'response.output_item.done': {
      const idx = data.output_index as number | undefined;
      const item = data.item as ResponsesItem | undefined;
      if (idx === undefined || !item) return {};
      accum.outputItems.set(idx, structuredClone(item));
      if (item.type === 'function_call') {
        const fc = item as ResponsesFunctionCallItem;
        // Prefer the args string the server gave us in the .done item; fall
        // back to the buffered deltas if the .done item came back with empty
        // arguments.
        const argsString =
          fc.arguments && fc.arguments !== ''
            ? fc.arguments
            : (accum.argsBuffers.get(idx) ?? []).join('');
        return {
          completedToolCall: {
            id: fc.call_id,
            name: fc.name,
            input: safeParseArgs(argsString) as ToolCall['input'],
          },
        };
      }
      return {};
    }
    case 'response.completed': {
      const r = data.response as AnyJson | undefined;
      if (r) {
        if (typeof r.status === 'string') accum.status = r.status;
        const usage = r.usage as ResponsesUsage | undefined;
        if (usage) accum.usage = usage;
      }
      return {};
    }
  }
  return {};
};

const finalizeItem = (idx: number, item: ResponsesItem, accum: AccumState): ResponsesItem => {
  if (item.type === 'message') {
    const buf = accum.textBuffers.get(idx);
    if (buf && buf.length > 0) {
      const m = item as ResponsesMessageItem;
      const accumulatedText = buf.join('');
      const existing = Array.isArray(m.content) && m.content.length > 0 ? m.content : [];
      const hasText = existing.some(
        (p) => typeof p === 'object' && (p.type === 'output_text' || p.type === 'input_text'),
      );
      if (hasText) {
        // Already finalized via response.output_item.done
        return item;
      }
      return {
        ...m,
        content: [{ type: 'output_text' as const, text: accumulatedText }],
      };
    }
  }
  if (item.type === 'function_call') {
    const buf = accum.argsBuffers.get(idx);
    const fc = item as ResponsesFunctionCallItem;
    if (buf && buf.length > 0 && (!fc.arguments || fc.arguments === '')) {
      return { ...fc, arguments: buf.join('') };
    }
  }
  return item;
};

const finalize = (accum: AccumState): ResponsesResponse => {
  const indices = [...accum.outputItems.keys()].sort((a, b) => a - b);
  const output: ResponsesItem[] = indices.map((idx) =>
    finalizeItem(idx, accum.outputItems.get(idx) as ResponsesItem, accum),
  );
  const out: ResponsesResponse = {
    id: accum.id ?? 'unknown',
    model: accum.model ?? 'unknown',
    output,
  };
  if (accum.status !== undefined) out.status = accum.status;
  if (accum.usage !== undefined) out.usage = accum.usage;
  return out;
};

export const consumeOpenAIResponsesStream = async (
  stream: ReadableStream<Uint8Array>,
  opts?: ConsumeStreamOpts,
): Promise<{
  response: ResponsesResponse;
  errored: Error | undefined;
  eagerlyEmittedCallIds?: string[];
  aborted?: boolean;
}> => {
  const accum = createAccum();
  const eagerlyEmittedCallIds: string[] = [];
  let aborted = false;
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = safeParse(value.data);
      if (!data) continue;
      const { completedToolCall } = processEvent(value.event, data, accum);
      if (completedToolCall && opts?.onToolCall) {
        eagerlyEmittedCallIds.push(completedToolCall.id);
        const decision = await opts.onToolCall(completedToolCall);
        if (decision.abort) {
          aborted = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  const out: {
    response: ResponsesResponse;
    errored: Error | undefined;
    eagerlyEmittedCallIds?: string[];
    aborted?: boolean;
  } = { response: finalize(accum), errored };
  if (eagerlyEmittedCallIds.length > 0) out.eagerlyEmittedCallIds = eagerlyEmittedCallIds;
  if (aborted) out.aborted = true;
  return out;
};
