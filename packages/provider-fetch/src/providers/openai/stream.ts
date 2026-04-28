import { type SseEvent, parseSseStream } from '../../sse.js';
import type { OpenAIChoice, OpenAIResponse, OpenAIToolCall, OpenAIUsage } from './types.js';

interface ToolAccum {
  id?: string;
  name?: string;
  argParts: string[];
}

interface AccumState {
  id?: string;
  model?: string;
  textParts: string[];
  reasoningParts: string[];
  toolCalls: Map<number, ToolAccum>;
  finishReason?: string;
  usage?: OpenAIUsage;
}

const createAccum = (): AccumState => ({
  textParts: [],
  reasoningParts: [],
  toolCalls: new Map(),
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

const processChunk = (data: AnyJson, accum: AccumState): void => {
  if (typeof data.id === 'string' && !accum.id) accum.id = data.id;
  if (typeof data.model === 'string' && !accum.model) accum.model = data.model;
  const usage = data.usage as OpenAIUsage | undefined;
  if (usage) accum.usage = usage;

  const choices = data.choices as Array<AnyJson> | undefined;
  const choice = choices?.[0];
  if (!choice) return;
  if (typeof choice.finish_reason === 'string') {
    accum.finishReason = choice.finish_reason as string;
  }
  const delta = choice.delta as AnyJson | undefined;
  if (!delta) return;
  if (typeof delta.content === 'string') accum.textParts.push(delta.content);
  if (typeof delta.reasoning_content === 'string') {
    accum.reasoningParts.push(delta.reasoning_content);
  }

  const toolDeltas = delta.tool_calls as Array<AnyJson> | undefined;
  if (toolDeltas) {
    for (const td of toolDeltas) {
      const idx = (td.index as number | undefined) ?? 0;
      let acc = accum.toolCalls.get(idx);
      if (!acc) {
        acc = { argParts: [] };
        accum.toolCalls.set(idx, acc);
      }
      if (typeof td.id === 'string') acc.id = td.id;
      const fn = td.function as AnyJson | undefined;
      if (fn) {
        if (typeof fn.name === 'string') acc.name = fn.name;
        if (typeof fn.arguments === 'string') acc.argParts.push(fn.arguments);
      }
    }
  }
};

const finalize = (accum: AccumState): OpenAIResponse => {
  const message: OpenAIChoice['message'] = {
    role: 'assistant',
    content: accum.textParts.length > 0 ? accum.textParts.join('') : null,
  };
  if (accum.reasoningParts.length > 0) {
    message.reasoning_content = accum.reasoningParts.join('');
  }
  if (accum.toolCalls.size > 0) {
    const tcs: OpenAIToolCall[] = [];
    const indices = [...accum.toolCalls.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const tc = accum.toolCalls.get(idx);
      if (!tc?.id || !tc.name) continue;
      tcs.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argParts.join('') },
      });
    }
    if (tcs.length > 0) message.tool_calls = tcs;
  }
  const choice: OpenAIChoice = { index: 0, message };
  if (accum.finishReason !== undefined) choice.finish_reason = accum.finishReason;
  const out: OpenAIResponse = {
    id: accum.id ?? 'unknown',
    model: accum.model ?? 'unknown',
    choices: [choice],
  };
  if (accum.usage !== undefined) out.usage = accum.usage;
  return out;
};

export const consumeOpenAIStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<{ response: OpenAIResponse; errored: Error | undefined }> => {
  const accum = createAccum();
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const ev: SseEvent = value;
      if (ev.data === '[DONE]') break;
      const data = safeParse(ev.data);
      if (data) processChunk(data, accum);
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  return { response: finalize(accum), errored };
};
