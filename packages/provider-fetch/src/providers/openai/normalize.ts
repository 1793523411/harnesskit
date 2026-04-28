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
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIToolCall,
  OpenAIUsage,
} from './types.js';

const safeParseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

const stringifyContent = (content: string | OpenAIContentPart[] | null | undefined): string => {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.map((p) => (p.type === 'text' ? p.text : `[image:${p.image_url.url}]`)).join('');
};

const normalizeMessage = (m: OpenAIMessage): NormalizedMessage[] => {
  if (m.role === 'system' || m.role === 'developer') {
    return [{ role: 'system', content: stringifyContent(m.content) }];
  }
  if (m.role === 'tool') {
    return [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: m.tool_call_id ?? '',
            content: stringifyContent(m.content),
          },
        ],
      },
    ];
  }
  if (m.role === 'user') {
    return [{ role: 'user', content: stringifyContent(m.content) }];
  }
  // assistant
  const hasReasoning = typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0;
  const hasTools = m.tool_calls && m.tool_calls.length > 0;
  if (hasReasoning || hasTools) {
    const blocks: NormalizedContent[] = [];
    if (hasReasoning) blocks.push({ type: 'thinking', text: m.reasoning_content as string });
    const text = stringifyContent(m.content);
    if (text) blocks.push({ type: 'text', text });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments ?? '{}'),
        });
      }
    }
    return [{ role: 'assistant', content: blocks }];
  }
  return [{ role: 'assistant', content: stringifyContent(m.content) }];
};

export const normalizeRequest = (req: OpenAIRequest): NormalizedRequest => {
  const messages: NormalizedMessage[] = [];
  for (const m of req.messages) messages.push(...normalizeMessage(m));
  const out: NormalizedRequest = { messages };
  if (req.tools) {
    out.tools = req.tools
      .filter((t) => t.type === 'function')
      .map((t) => {
        const td: ToolDefinition = {
          name: t.function.name,
          inputSchema: t.function.parameters ?? {},
        };
        if (t.function.description !== undefined) td.description = t.function.description;
        return td;
      });
  }
  const max = req.max_completion_tokens ?? req.max_tokens;
  if (max !== undefined) out.maxTokens = max;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  return out;
};

export const normalizeResponse = (res: OpenAIResponse): NormalizedResponse => {
  const choice = res.choices[0];
  if (!choice) return { content: [] };
  const blocks: NormalizedContent[] = [];
  if (choice.message.reasoning_content) {
    blocks.push({ type: 'thinking', text: choice.message.reasoning_content });
  }
  const text = stringifyContent(choice.message.content);
  if (text) blocks.push({ type: 'text', text });
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments ?? '{}'),
      });
    }
  }
  const out: NormalizedResponse = { content: blocks };
  if (choice.finish_reason !== undefined) out.stopReason = choice.finish_reason;
  return out;
};

export const extractUsage = (u: OpenAIUsage | undefined): UsageInfo | undefined => {
  if (!u) return undefined;
  const out: UsageInfo = {};
  if (u.prompt_tokens !== undefined) out.inputTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.outputTokens = u.completion_tokens;
  if (u.prompt_tokens_details?.cached_tokens !== undefined) {
    out.cacheReadTokens = u.prompt_tokens_details.cached_tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const extractToolCalls = (res: OpenAIResponse): ToolCall[] => {
  const choice = res.choices[0];
  if (!choice?.message.tool_calls) return [];
  return choice.message.tool_calls.map((tc: OpenAIToolCall) => ({
    id: tc.id,
    name: tc.function.name,
    input: safeParseJson(tc.function.arguments ?? '{}'),
  }));
};
