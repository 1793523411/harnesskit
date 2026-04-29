import type {
  NormalizedContent,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  ToolCall,
  ToolDefinition,
  UsageInfo,
} from '@harnesskit/core';
import type {
  GeminiCandidate,
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiPart,
  GeminiRequest,
  GeminiResponse,
  GeminiTextPart,
  GeminiUsage,
} from './types.js';

const isTextPart = (p: GeminiPart): p is GeminiTextPart =>
  typeof (p as GeminiTextPart).text === 'string';
const isFunctionCallPart = (p: GeminiPart): p is GeminiFunctionCallPart =>
  typeof (p as GeminiFunctionCallPart).functionCall === 'object' &&
  (p as GeminiFunctionCallPart).functionCall !== null;
const isFunctionResponsePart = (p: GeminiPart): p is GeminiFunctionResponsePart =>
  typeof (p as GeminiFunctionResponsePart).functionResponse === 'object' &&
  (p as GeminiFunctionResponsePart).functionResponse !== null;

const partsToBlocks = (parts: GeminiPart[]): NormalizedContent[] => {
  const blocks: NormalizedContent[] = [];
  for (const p of parts) {
    if (isTextPart(p)) {
      if (p.thought) blocks.push({ type: 'thinking', text: p.text });
      else if (p.text) blocks.push({ type: 'text', text: p.text });
    } else if (isFunctionCallPart(p)) {
      const id = p.functionCall.id ?? `gemini_fc_${p.functionCall.name}`;
      blocks.push({
        type: 'tool_use',
        id,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    } else if (isFunctionResponsePart(p)) {
      const id = p.functionResponse.id ?? `gemini_fc_${p.functionResponse.name}`;
      const content =
        typeof p.functionResponse.response === 'string'
          ? p.functionResponse.response
          : JSON.stringify(p.functionResponse.response);
      blocks.push({ type: 'tool_result', toolUseId: id, content });
    }
  }
  return blocks;
};

const contentToMessage = (c: GeminiContent): NormalizedMessage[] => {
  const role = c.role === 'model' ? 'assistant' : 'user';
  const blocks = partsToBlocks(c.parts);
  if (blocks.length === 0) return [];
  // Function-response parts in user contents become tool_result blocks (which is
  // already user-role in the normalized model). Pure text becomes string content.
  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return [{ role, content: blocks[0].text }];
  }
  return [{ role, content: blocks }];
};

const systemInstructionToString = (s: GeminiRequest['systemInstruction']): string | undefined => {
  if (!s) return undefined;
  const parts = (s as GeminiContent).parts ?? [];
  return (
    parts
      .filter(isTextPart)
      .map((p) => p.text)
      .join('\n') || undefined
  );
};

export const normalizeRequest = (req: GeminiRequest): NormalizedRequest => {
  const messages: NormalizedMessage[] = [];
  for (const c of req.contents) messages.push(...contentToMessage(c));
  const out: NormalizedRequest = { messages };
  const sys = systemInstructionToString(req.systemInstruction);
  if (sys) out.system = sys;
  if (req.tools) {
    const decls: ToolDefinition[] = [];
    for (const t of req.tools) {
      if (!t.functionDeclarations) continue;
      for (const fd of t.functionDeclarations) {
        const td: ToolDefinition = { name: fd.name, inputSchema: fd.parameters ?? {} };
        if (fd.description !== undefined) td.description = fd.description;
        decls.push(td);
      }
    }
    if (decls.length > 0) out.tools = decls;
  }
  if (req.generationConfig?.maxOutputTokens !== undefined) {
    out.maxTokens = req.generationConfig.maxOutputTokens;
  }
  if (req.generationConfig?.temperature !== undefined) {
    out.temperature = req.generationConfig.temperature;
  }
  return out;
};

export const normalizeResponse = (res: GeminiResponse): NormalizedResponse => {
  const candidate: GeminiCandidate | undefined = res.candidates?.[0];
  if (!candidate?.content) return { content: [] };
  const blocks = partsToBlocks(candidate.content.parts ?? []);
  const out: NormalizedResponse = { content: blocks };
  if (candidate.finishReason !== undefined) out.stopReason = candidate.finishReason;
  return out;
};

export const extractToolCalls = (res: GeminiResponse): ToolCall[] => {
  const calls: ToolCall[] = [];
  const candidate = res.candidates?.[0];
  if (!candidate?.content?.parts) return calls;
  for (const p of candidate.content.parts) {
    if (isFunctionCallPart(p)) {
      const id = p.functionCall.id ?? `gemini_fc_${p.functionCall.name}`;
      calls.push({ id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    }
  }
  return calls;
};

export const extractUsage = (u: GeminiUsage | undefined): UsageInfo | undefined => {
  if (!u) return undefined;
  const out: UsageInfo = {};
  if (u.promptTokenCount !== undefined) out.inputTokens = u.promptTokenCount;
  if (u.candidatesTokenCount !== undefined) out.outputTokens = u.candidatesTokenCount;
  if (u.cachedContentTokenCount !== undefined) out.cacheReadTokens = u.cachedContentTokenCount;
  return Object.keys(out).length > 0 ? out : undefined;
};
