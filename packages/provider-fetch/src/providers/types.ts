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
  };
}

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
  parseRequest(body: unknown): unknown | undefined;
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
  ): Promise<{ response: unknown; errored: Error | undefined }>;
  parseResponseText(text: string): unknown | undefined;
  normalizeResponse(res: unknown): NormalizedResponse;
  extractToolCalls(res: unknown): ToolCall[];
  extractUsage(res: unknown): UsageInfo | undefined;
}
