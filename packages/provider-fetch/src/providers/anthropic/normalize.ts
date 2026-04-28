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
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolUseBlock,
  AnthropicUsage,
} from './types.js';

const normalizeContent = (b: AnthropicContentBlock): NormalizedContent => {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      return { type: 'thinking', text: b.thinking };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result': {
      const out: NormalizedContent = {
        type: 'tool_result',
        toolUseId: b.tool_use_id,
        content: typeof b.content === 'string' ? b.content : b.content.map(normalizeContent),
      };
      if (b.is_error) out.isError = true;
      return out;
    }
  }
};

const normalizeMessage = (m: AnthropicMessage): NormalizedMessage => ({
  role: m.role,
  content: typeof m.content === 'string' ? m.content : m.content.map(normalizeContent),
});

export const normalizeRequest = (req: AnthropicRequest): NormalizedRequest => {
  const out: NormalizedRequest = {
    messages: req.messages.map(normalizeMessage),
  };
  if (req.system !== undefined) {
    out.system =
      typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n');
  }
  if (req.tools !== undefined) {
    out.tools = req.tools.map((t) => {
      const td: ToolDefinition = { name: t.name, inputSchema: t.input_schema };
      if (t.description !== undefined) td.description = t.description;
      return td;
    });
  }
  if (req.max_tokens !== undefined) out.maxTokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  return out;
};

export const normalizeResponse = (res: AnthropicResponse): NormalizedResponse => {
  const out: NormalizedResponse = {
    content: res.content.map(normalizeContent),
  };
  if (res.stop_reason !== undefined) out.stopReason = res.stop_reason;
  return out;
};

export const extractUsage = (u: AnthropicUsage | undefined): UsageInfo | undefined => {
  if (!u) return undefined;
  const out: UsageInfo = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.cache_read_input_tokens !== undefined) out.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined) {
    out.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const extractToolCalls = (res: AnthropicResponse): ToolCall[] =>
  res.content
    .filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
