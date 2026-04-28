import { parseSseStream } from '../../sse.js';
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

const processEvent = (eventName: string | undefined, data: AnyJson, accum: AccumState): void => {
  if (!eventName) return;

  switch (eventName) {
    case 'response.created':
    case 'response.in_progress': {
      const r = data.response as AnyJson | undefined;
      if (r) {
        if (typeof r.id === 'string') accum.id = r.id;
        if (typeof r.model === 'string') accum.model = r.model;
      }
      break;
    }
    case 'response.output_item.added': {
      const idx = data.output_index as number | undefined;
      const item = data.item as ResponsesItem | undefined;
      if (idx === undefined || !item) break;
      accum.outputItems.set(idx, structuredClone(item));
      if (item.type === 'message') accum.textBuffers.set(idx, []);
      if (item.type === 'function_call') accum.argsBuffers.set(idx, []);
      break;
    }
    case 'response.output_text.delta': {
      const idx = data.output_index as number | undefined;
      const delta = data.delta as string | undefined;
      if (idx === undefined || typeof delta !== 'string') break;
      const buf = accum.textBuffers.get(idx);
      if (buf) buf.push(delta);
      break;
    }
    case 'response.function_call_arguments.delta': {
      const idx = data.output_index as number | undefined;
      const delta = data.delta as string | undefined;
      if (idx === undefined || typeof delta !== 'string') break;
      const buf = accum.argsBuffers.get(idx);
      if (buf) buf.push(delta);
      break;
    }
    case 'response.output_item.done': {
      const idx = data.output_index as number | undefined;
      const item = data.item as ResponsesItem | undefined;
      if (idx === undefined || !item) break;
      accum.outputItems.set(idx, structuredClone(item));
      break;
    }
    case 'response.completed': {
      const r = data.response as AnyJson | undefined;
      if (r) {
        if (typeof r.status === 'string') accum.status = r.status;
        const usage = r.usage as ResponsesUsage | undefined;
        if (usage) accum.usage = usage;
      }
      break;
    }
  }
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
): Promise<{ response: ResponsesResponse; errored: Error | undefined }> => {
  const accum = createAccum();
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = safeParse(value.data);
      if (data) processEvent(value.event, data, accum);
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  return { response: finalize(accum), errored };
};
