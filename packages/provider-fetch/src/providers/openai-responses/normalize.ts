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
  ResponsesContentPart,
  ResponsesFunctionCallItem,
  ResponsesItem,
  ResponsesMessageItem,
  ResponsesRequest,
  ResponsesResponse,
  ResponsesUsage,
} from './types.js';

const safeParseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

const stringifyParts = (parts: ResponsesContentPart[] | string): string => {
  if (typeof parts === 'string') return parts;
  return parts
    .map((p) => {
      if (p.type === 'input_text' || p.type === 'output_text') {
        return (p as { text: string }).text;
      }
      return '';
    })
    .join('');
};

const isMessageItem = (i: ResponsesItem): i is ResponsesMessageItem => i.type === 'message';
const isFunctionCallItem = (i: ResponsesItem): i is ResponsesFunctionCallItem =>
  i.type === 'function_call';
const isFunctionCallOutputItem = (
  i: ResponsesItem,
): i is { type: 'function_call_output'; call_id: string; output: string } =>
  i.type === 'function_call_output';

const messageItemToNormalized = (m: ResponsesMessageItem): NormalizedMessage => {
  const role = m.role === 'developer' ? 'system' : (m.role as 'system' | 'user' | 'assistant');
  return { role, content: stringifyParts(m.content) };
};

const itemsToNormalizedMessages = (items: ResponsesItem[]): NormalizedMessage[] => {
  const out: NormalizedMessage[] = [];
  for (const item of items) {
    if (isMessageItem(item)) {
      out.push(messageItemToNormalized(item));
    } else if (isFunctionCallItem(item)) {
      out.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: safeParseJson(item.arguments ?? '{}'),
          },
        ],
      });
    } else if (isFunctionCallOutputItem(item)) {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: item.call_id,
            content: item.output,
          },
        ],
      });
    }
    // reasoning and other item types are skipped in the normalized view
  }
  return out;
};

export const normalizeRequest = (req: ResponsesRequest): NormalizedRequest => {
  const items: ResponsesItem[] =
    typeof req.input === 'string'
      ? [{ type: 'message', role: 'user', content: req.input }]
      : req.input;
  const messages = itemsToNormalizedMessages(items);
  const out: NormalizedRequest = { messages };
  if (req.instructions !== undefined) out.system = req.instructions;
  if (req.tools !== undefined) {
    out.tools = req.tools
      .filter((t) => t.type === 'function')
      .map((t) => {
        const td: ToolDefinition = { name: t.name, inputSchema: t.parameters ?? {} };
        if (t.description !== undefined) td.description = t.description;
        return td;
      });
  }
  if (req.max_output_tokens !== undefined) out.maxTokens = req.max_output_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  return out;
};

export const normalizeResponse = (res: ResponsesResponse): NormalizedResponse => {
  const blocks: NormalizedContent[] = [];
  for (const item of res.output) {
    if (isMessageItem(item)) {
      const text = stringifyParts(item.content);
      if (text) blocks.push({ type: 'text', text });
    } else if (isFunctionCallItem(item)) {
      blocks.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: safeParseJson(item.arguments ?? '{}'),
      });
    }
  }
  const out: NormalizedResponse = { content: blocks };
  if (res.status !== undefined) out.stopReason = res.status;
  return out;
};

export const extractToolCalls = (res: ResponsesResponse): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const item of res.output) {
    if (isFunctionCallItem(item)) {
      calls.push({
        id: item.call_id,
        name: item.name,
        input: safeParseJson(item.arguments ?? '{}'),
      });
    }
  }
  return calls;
};

export const extractUsage = (u: ResponsesUsage | undefined): UsageInfo | undefined => {
  if (!u) return undefined;
  const out: UsageInfo = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.input_tokens_details?.cached_tokens !== undefined) {
    out.cacheReadTokens = u.input_tokens_details.cached_tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};
