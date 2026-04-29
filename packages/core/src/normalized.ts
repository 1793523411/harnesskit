export type Provider =
  | 'anthropic'
  | 'openai'
  | 'openai-responses'
  | 'google'
  | 'openrouter'
  | 'bedrock'
  | 'unknown';

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type NormalizedContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string | NormalizedContent[];
      isError?: boolean;
    }
  | { type: 'thinking'; text: string };

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | NormalizedContent[];
}

export interface NormalizedRequest {
  system?: string;
  messages: NormalizedMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface NormalizedResponse {
  content: NormalizedContent[];
  stopReason?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  content: string | NormalizedContent[];
  isError?: boolean;
  durationMs?: number;
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}
