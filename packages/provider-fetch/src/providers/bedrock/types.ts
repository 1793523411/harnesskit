// AWS Bedrock Converse API wire types.
// Reference: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html

export interface BedrockTextBlock {
  text: string;
}

export interface BedrockImageBlock {
  image: {
    format: 'png' | 'jpeg' | 'gif' | 'webp';
    source: { bytes: string } | { s3Location: { uri: string } };
  };
}

export interface BedrockToolUseBlock {
  toolUse: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
}

export interface BedrockToolResultBlock {
  toolResult: {
    toolUseId: string;
    /** Content can be a string or array of content blocks */
    content: Array<{ text: string } | { json: unknown }>;
    status?: 'success' | 'error';
  };
}

export type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockImageBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock;

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

export interface BedrockSystemBlock {
  text: string;
}

export interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: { json: unknown };
  };
}

export interface BedrockInferenceConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface BedrockRequest {
  messages: BedrockMessage[];
  system?: BedrockSystemBlock[];
  inferenceConfig?: BedrockInferenceConfig;
  toolConfig?: {
    tools?: BedrockToolSpec[];
    toolChoice?: { auto?: object } | { any?: object } | { tool?: { name: string } };
  };
  /** Internal — model id from URL path */
  _harnessModel?: string;
  /** Internal — true when path is /converse-stream */
  _harnessStream?: boolean;
  [key: string]: unknown;
}

export interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface BedrockResponse {
  output: {
    message: BedrockMessage;
  };
  stopReason?: string;
  usage?: BedrockUsage;
  metrics?: { latencyMs?: number };
}
