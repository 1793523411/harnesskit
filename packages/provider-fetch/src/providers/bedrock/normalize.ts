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
  BedrockContentBlock,
  BedrockMessage,
  BedrockRequest,
  BedrockResponse,
  BedrockUsage,
} from './types.js';

const isText = (b: BedrockContentBlock): b is { text: string } =>
  typeof (b as { text?: unknown }).text === 'string';

const isToolUse = (
  b: BedrockContentBlock,
): b is { toolUse: { toolUseId: string; name: string; input: unknown } } =>
  typeof (b as { toolUse?: unknown }).toolUse === 'object' &&
  (b as { toolUse?: unknown }).toolUse !== null;

const isToolResult = (
  b: BedrockContentBlock,
): b is {
  toolResult: {
    toolUseId: string;
    content: Array<{ text: string } | { json: unknown }>;
    status?: 'success' | 'error';
  };
} =>
  typeof (b as { toolResult?: unknown }).toolResult === 'object' &&
  (b as { toolResult?: unknown }).toolResult !== null;

const stringifyToolResultContent = (
  parts: Array<{ text?: string; json?: unknown }>,
): string =>
  parts
    .map((p) => (typeof p.text === 'string' ? p.text : JSON.stringify(p.json ?? '')))
    .join('\n');

const blocksToNormalized = (blocks: BedrockContentBlock[]): NormalizedContent[] => {
  const out: NormalizedContent[] = [];
  for (const b of blocks) {
    if (isText(b)) {
      if (b.text) out.push({ type: 'text', text: b.text });
    } else if (isToolUse(b)) {
      out.push({
        type: 'tool_use',
        id: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input,
      });
    } else if (isToolResult(b)) {
      const content = stringifyToolResultContent(b.toolResult.content);
      const block: NormalizedContent = {
        type: 'tool_result',
        toolUseId: b.toolResult.toolUseId,
        content,
      };
      if (b.toolResult.status === 'error') block.isError = true;
      out.push(block);
    }
  }
  return out;
};

const messageToNormalized = (m: BedrockMessage): NormalizedMessage => {
  const blocks = blocksToNormalized(m.content);
  if (blocks.length === 1 && blocks[0]?.type === 'text') {
    return { role: m.role, content: blocks[0].text };
  }
  return { role: m.role, content: blocks };
};

export const normalizeRequest = (req: BedrockRequest): NormalizedRequest => {
  const messages: NormalizedMessage[] = req.messages.map(messageToNormalized);
  const out: NormalizedRequest = { messages };
  if (req.system && req.system.length > 0) {
    out.system = req.system.map((s) => s.text).join('\n');
  }
  if (req.toolConfig?.tools) {
    const tools: ToolDefinition[] = [];
    for (const t of req.toolConfig.tools) {
      const td: ToolDefinition = {
        name: t.toolSpec.name,
        inputSchema: t.toolSpec.inputSchema?.json ?? {},
      };
      if (t.toolSpec.description !== undefined) td.description = t.toolSpec.description;
      tools.push(td);
    }
    if (tools.length > 0) out.tools = tools;
  }
  if (req.inferenceConfig?.maxTokens !== undefined) out.maxTokens = req.inferenceConfig.maxTokens;
  if (req.inferenceConfig?.temperature !== undefined)
    out.temperature = req.inferenceConfig.temperature;
  return out;
};

export const normalizeResponse = (res: BedrockResponse): NormalizedResponse => {
  const blocks = blocksToNormalized(res.output?.message?.content ?? []);
  const out: NormalizedResponse = { content: blocks };
  if (res.stopReason !== undefined) out.stopReason = res.stopReason;
  return out;
};

export const extractToolCalls = (res: BedrockResponse): ToolCall[] => {
  const calls: ToolCall[] = [];
  for (const b of res.output?.message?.content ?? []) {
    if (isToolUse(b)) {
      calls.push({
        id: b.toolUse.toolUseId,
        name: b.toolUse.name,
        input: b.toolUse.input,
      });
    }
  }
  return calls;
};

export const extractUsage = (u: BedrockUsage | undefined): UsageInfo | undefined => {
  if (!u) return undefined;
  const out: UsageInfo = {};
  if (u.inputTokens !== undefined) out.inputTokens = u.inputTokens;
  if (u.outputTokens !== undefined) out.outputTokens = u.outputTokens;
  if (u.cacheReadInputTokens !== undefined) out.cacheReadTokens = u.cacheReadInputTokens;
  return Object.keys(out).length > 0 ? out : undefined;
};
