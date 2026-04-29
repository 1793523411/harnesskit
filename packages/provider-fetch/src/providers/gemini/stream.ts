import { parseSseStream } from '../../sse.js';
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

const processChunk = (data: AnyJson, accum: AccumState): void => {
  if (typeof data.modelVersion === 'string' && !accum.modelVersion) {
    accum.modelVersion = data.modelVersion;
  }
  const usage = data.usageMetadata as GeminiUsage | undefined;
  if (usage) accum.usage = usage;

  const candidates = data.candidates as Array<AnyJson> | undefined;
  const candidate = candidates?.[0];
  if (!candidate) return;
  if (typeof candidate.finishReason === 'string') {
    accum.finishReason = candidate.finishReason as string;
  }
  const content = candidate.content as { parts?: GeminiPart[] } | undefined;
  if (!content?.parts) return;
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
      }
    }
  }
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

export const consumeGeminiStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<{ response: GeminiResponse; errored: Error | undefined }> => {
  const accum = createAccum();
  let errored: Error | undefined;
  try {
    const reader = parseSseStream(stream).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const data = safeParse(value.data);
      if (data) processChunk(data, accum);
    }
  } catch (err) {
    errored = err instanceof Error ? err : new Error(String(err));
  }
  return { response: finalize(accum), errored };
};
