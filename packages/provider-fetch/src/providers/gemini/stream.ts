import type { ToolCall } from '@harnesskit/core';
import { parseSseStream } from '../../sse.js';
import type { ConsumeStreamOpts } from '../types.js';
import type {
  GeminiCandidate,
  GeminiPart,
  GeminiResponse,
  GeminiTextPart,
  GeminiUsage,
} from './types.js';

interface AccumState {
  modelVersion?: string;
  textParts: string[];
  thoughtParts: string[];
  functionCalls: Map<string, { name: string; args: unknown; id?: string }>;
  finishReason?: string;
  usage?: GeminiUsage;
}

const createAccum = (): AccumState => ({
  textParts: [],
  thoughtParts: [],
  functionCalls: new Map(),
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
 * Mutates `accum` in place. Returns the keys (Map keys, see below) of any
 * function-call entries that became newly fully-formed in this chunk — caller
 * can fire the eager onToolCall hook for each.
 *
 * In Gemini, a `functionCall` part arrives complete inside a single chunk's
 * `content.parts[]` (args are not split across deltas). So a "new key" in this
 * chunk == a complete tool call ready for mid-stream gating.
 */
const processChunk = (
  data: AnyJson,
  accum: AccumState,
): { newCallKeys: string[] } => {
  const newCallKeys: string[] = [];
  if (typeof data.modelVersion === 'string' && !accum.modelVersion) {
    accum.modelVersion = data.modelVersion;
  }
  const usage = data.usageMetadata as GeminiUsage | undefined;
  if (usage) accum.usage = usage;

  const candidates = data.candidates as Array<AnyJson> | undefined;
  const candidate = candidates?.[0];
  if (!candidate) return { newCallKeys };
  if (typeof candidate.finishReason === 'string') {
    accum.finishReason = candidate.finishReason as string;
  }
  const content = candidate.content as { parts?: GeminiPart[] } | undefined;
  if (!content?.parts) return { newCallKeys };
  for (const p of content.parts) {
    if (typeof (p as GeminiTextPart).text === 'string') {
      const tp = p as GeminiTextPart;
      if (tp.thought) accum.thoughtParts.push(tp.text);
      else accum.textParts.push(tp.text);
    } else if (
      typeof (p as { functionCall?: { name?: string; args?: unknown; id?: string } })
        .functionCall === 'object'
    ) {
      const fc = (p as { functionCall: { name: string; args?: unknown; id?: string } })
        .functionCall;
      const key = fc.id ?? `gemini_fc_${fc.name}`;
      const existing = accum.functionCalls.get(key);
      if (existing) {
        existing.args = fc.args ?? existing.args;
        if (fc.id) existing.id = fc.id;
      } else {
        const entry: { name: string; args: unknown; id?: string } = {
          name: fc.name,
          args: fc.args ?? {},
        };
        if (fc.id !== undefined) entry.id = fc.id;
        accum.functionCalls.set(key, entry);
        newCallKeys.push(key);
      }
    }
  }
  return { newCallKeys };
};

const finalize = (accum: AccumState): GeminiResponse => {
  const parts: GeminiPart[] = [];
  if (accum.thoughtParts.length > 0) {
    parts.push({ text: accum.thoughtParts.join(''), thought: true });
  }
  if (accum.textParts.length > 0) {
    parts.push({ text: accum.textParts.join('') });
  }
  for (const [, fc] of accum.functionCalls) {
    parts.push({
      functionCall: {
        ...(fc.id ? { id: fc.id } : {}),
        name: fc.name,
        args: fc.args,
      },
    });
  }
  const candidate: GeminiCandidate = {
    content: { role: 'model', parts },
    index: 0,
  };
  if (accum.finishReason !== undefined) candidate.finishReason = accum.finishReason;
  const out: GeminiResponse = { candidates: [candidate] };
  if (accum.modelVersion !== undefined) out.modelVersion = accum.modelVersion;
  if (accum.usage !== undefined) out.usageMetadata = accum.usage;
  return out;
};

const buildEagerToolCall = (
  key: string,
  fc: { name: string; args: unknown; id?: string },
): ToolCall => {
  const id = fc.id ?? key;
  return { id, name: fc.name, input: (fc.args ?? {}) as ToolCall['input'] };
};

export const consumeGeminiStream = async (
  stream: ReadableStream<Uint8Array>,
  opts?: ConsumeStreamOpts,
): Promise<{
  response: GeminiResponse;
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
      const { newCallKeys } = processChunk(data, accum);
      if (newCallKeys.length > 0 && opts?.onToolCall) {
        let didAbort = false;
        for (const key of newCallKeys) {
          const fc = accum.functionCalls.get(key);
          if (!fc) continue;
          const call = buildEagerToolCall(key, fc);
          eagerlyEmittedCallIds.push(call.id);
          const decision = await opts.onToolCall(call);
          if (decision.abort) {
            aborted = true;
            didAbort = true;
            break;
          }
        }
        if (didAbort) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  const out: {
    response: GeminiResponse;
    errored: Error | undefined;
    eagerlyEmittedCallIds?: string[];
    aborted?: boolean;
  } = { response: finalize(accum), errored };
  if (eagerlyEmittedCallIds.length > 0) out.eagerlyEmittedCallIds = eagerlyEmittedCallIds;
  if (aborted) out.aborted = true;
  return out;
};
