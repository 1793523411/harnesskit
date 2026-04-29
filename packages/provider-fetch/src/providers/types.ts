import type {
  NormalizedRequest,
  NormalizedResponse,
  Provider,
  ToolCall,
  UsageInfo,
} from '@harnesskit/core';

export type ProviderTag = Exclude<Provider, 'unknown'>;

export interface ProviderDetectOpts {
  customHosts?: {
    anthropic?: readonly string[];
    openai?: readonly string[];
    openrouter?: readonly string[];
    google?: readonly string[];
    bedrock?: readonly string[];
  };
}

/**
 * Optional hooks passed by intercept.ts when consuming a streaming response.
 * Providers that can identify tool calls mid-stream (Anthropic content_block_stop,
 * Gemini complete functionCall part) call onToolCall as soon as the call is
 * fully assembled. Returning `{abort:true}` causes the consumer to stop
 * reading; intercept.ts then cancels the upstream connection.
 */
export interface ConsumeStreamOpts {
  onToolCall?: (call: ToolCall) => Promise<{ abort: boolean }>;
}

/**
 * Applied to outgoing tool-result content blocks before the wire layer
 * serializes the request. Returning `undefined` leaves content unchanged.
 * Returning a string replaces the content. Used by builtins like
 * `redactPiiInToolResults` to actively scrub data flowing back to the model.
 */
export type ToolResultRewriter = (
  content: string,
  ctx: { toolUseId: string },
) => string | undefined;

/**
 * Provider implementations are opaque at the registry level: requests and
 * responses are typed `unknown` so the registry can hold heterogeneous providers
 * without generics ceremony. Each impl casts internally.
 */
export interface ProviderImpl {
  readonly tag: ProviderTag;
  detect(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    opts: ProviderDetectOpts,
  ): boolean;
  parseRequest(body: unknown, ctx: { url: URL }): unknown | undefined;
  applyDeny(
    req: unknown,
    deniedCalls: ReadonlyMap<string, string>,
  ): { rewritten: unknown; rewroteIds: string[] };
  serializeRequest(req: unknown): string;
  isStreamRequest(req: unknown): boolean;
  getModel(req: unknown): string;
  normalizeRequest(req: unknown): NormalizedRequest;
  consumeStream(
    stream: ReadableStream<Uint8Array>,
    opts?: ConsumeStreamOpts,
  ): Promise<{
    response: unknown;
    errored: Error | undefined;
    /** Tool-call ids that were already eagerly emitted via opts.onToolCall. */
    eagerlyEmittedCallIds?: string[];
    /** True if the consumer aborted early due to onToolCall returning {abort:true}. */
    aborted?: boolean;
  }>;
  parseResponseText(text: string): unknown | undefined;
  normalizeResponse(res: unknown): NormalizedResponse;
  extractToolCalls(res: unknown): ToolCall[];
  extractUsage(res: unknown): UsageInfo | undefined;
  /**
   * Optional. Walks the parsed request and applies the rewriter to each
   * outgoing tool-result content block. Implemented by Anthropic, OpenAI Chat,
   * OpenAI Responses, and Gemini.
   */
  applyContentRewrites?(
    req: unknown,
    rewriter: ToolResultRewriter,
  ): { rewritten: unknown; rewroteIds: string[] };
}
