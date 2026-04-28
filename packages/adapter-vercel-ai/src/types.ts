/**
 * Subset of the `ai` package shape we touch. Mirrors:
 *  - generateText/streamText options object
 *  - StepResult passed to onStepFinish
 *  - tool() output (with execute callback)
 */

export interface ToolCallContextLike {
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

export interface ToolLike {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, ctx: ToolCallContextLike) => unknown;
  [key: string]: unknown;
}

export interface StepToolCallLike {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface StepToolResultLike {
  toolCallId: string;
  toolName?: string;
  output?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface StepUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  [key: string]: unknown;
}

export interface StepResultLike {
  stepNumber?: number;
  model?: { provider?: string; modelId?: string };
  text?: string;
  toolCalls?: StepToolCallLike[];
  toolResults?: StepToolResultLike[];
  usage?: StepUsageLike;
  finishReason?: string;
  [key: string]: unknown;
}

export interface VercelAiOptionsLike {
  tools?: Record<string, ToolLike>;
  onStepFinish?: (step: StepResultLike) => unknown | Promise<unknown>;
  onFinish?: (event: unknown) => unknown | Promise<unknown>;
  [key: string]: unknown;
}
