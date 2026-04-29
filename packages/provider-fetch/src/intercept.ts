import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  type ToolCall,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import { anthropicProvider } from './providers/anthropic/index.js';
import { bedrockProvider } from './providers/bedrock/index.js';
import { geminiProvider } from './providers/gemini/index.js';
import { openaiResponsesProvider } from './providers/openai-responses/index.js';
import { openaiProvider, openrouterProvider } from './providers/openai/index.js';
import type {
  ProviderDetectOpts,
  ProviderImpl,
  ProviderTag,
  ToolResultRewriter,
} from './providers/types.js';
import { type RedactOption, redactHeaders } from './redact.js';
import { type InterceptorState, createState } from './state.js';

export type { ProviderTag, ToolResultRewriter } from './providers/types.js';

export interface FetchInterceptorOptions {
  bus: EventBus;
  /** Which providers to recognize. Default: all built-in. */
  providers?: readonly ProviderTag[];
  /** Override target. Defaults to globalThis. */
  target?: { fetch: typeof fetch };
  /** Resolves the sessionId for each turn. Default: generates one at install time. */
  getSessionId?: () => string;
  /** Header redaction policy. Default: 'standard'. */
  redactHeaders?: RedactOption;
  /** Attach raw provider request/response on emitted events. Default: false. */
  includeRaw?: boolean;
  /** Provider-specific overrides. */
  customHosts?: ProviderDetectOpts['customHosts'];
  /**
   * Active wire-level rewriter for outgoing tool-result content. Applied after
   * deny rewrites and before serialization. Returning `undefined` from the
   * rewriter leaves a block unchanged. Returning a string replaces the
   * tool-result content the model is about to see. See
   * `redactPiiInToolResults` in @harnesskit/policy.
   *
   * Pass an array to chain multiple rewriters — each runs in order and the
   * output of one feeds the next. A rewriter that throws is caught, logged
   * as an `error` event, and treated as a no-op for that block.
   */
  rewriteToolResults?: ToolResultRewriter | readonly ToolResultRewriter[];
  /**
   * Optional request signer. Called after deny + content rewrite, before the
   * upstream fetch. Lets you inject auth headers (e.g. AWS Sig V4 for Bedrock)
   * computed from the final serialized body. Return any header overrides;
   * the harness merges them into the outgoing request.
   *
   * Recipe with `aws4fetch`:
   *
   * ```ts
   * import { AwsClient } from 'aws4fetch';
   * const aws = new AwsClient({ accessKeyId, secretAccessKey, region });
   * installFetchInterceptor({
   *   bus,
   *   signRequest: async ({ url, method, headers, body }) => {
   *     const signed = await aws.sign(new Request(url, { method, headers, body }));
   *     return { headers: Object.fromEntries(signed.headers) };
   *   },
   * });
   * ```
   */
  signRequest?: SignRequestHook;
}

export interface SignRequestInput {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  provider: ProviderTag;
}

export type SignRequestHook = (
  input: SignRequestInput,
) => Promise<{ headers?: Record<string, string> } | undefined> | { headers?: Record<string, string> } | undefined;

const BUILTIN_PROVIDERS: readonly ProviderImpl[] = [
  anthropicProvider,
  openaiResponsesProvider,
  bedrockProvider,
  geminiProvider,
  openaiProvider,
  openrouterProvider,
];

interface InternalCtx {
  bus: EventBus;
  state: InterceptorState;
  includeRaw: boolean;
  redact: RedactOption;
}

const readJsonBody = (init: RequestInit | undefined): unknown => {
  const body = init?.body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const composeRewriters = (
  rewriters: ToolResultRewriter | readonly ToolResultRewriter[],
  bus: EventBus,
  providerTag: ProviderTag,
): ToolResultRewriter => {
  const list = Array.isArray(rewriters) ? rewriters : [rewriters as ToolResultRewriter];
  if (list.length === 1) {
    const r = list[0];
    if (!r) return () => undefined;
    return (content, ctx) => {
      try {
        return r(content, ctx);
      } catch (err) {
        void bus.emit({
          type: 'error',
          ts: Date.now(),
          ids: { sessionId: 'rewrite', turnId: 'rewrite', callId: ctx.toolUseId },
          source: 'l1',
          message: err instanceof Error ? err.message : String(err),
          stage: 'turn.start',
          cause: err,
        });
        return undefined;
      }
    };
  }
  return (content, ctx) => {
    let current = content;
    let touched = false;
    for (const r of list) {
      try {
        const next = r(current, ctx);
        if (next !== undefined && next !== current) {
          current = next;
          touched = true;
        }
      } catch (err) {
        void bus.emit({
          type: 'error',
          ts: Date.now(),
          ids: { sessionId: 'rewrite', turnId: 'rewrite', callId: ctx.toolUseId },
          source: 'l1',
          message: `[${providerTag}] rewriter threw: ${err instanceof Error ? err.message : String(err)}`,
          stage: 'turn.start',
          cause: err,
        });
      }
    }
    return touched ? current : undefined;
  };
};

interface ApplySignArgs {
  init: RequestInit | undefined;
  body: string;
  url: string;
  providerTag: ProviderTag;
  hook: SignRequestHook | undefined;
}

const applySignRequest = async (args: ApplySignArgs): Promise<RequestInit> => {
  const baseInit = cloneInitWithBody(args.init, args.body);
  if (!args.hook) return baseInit;
  const baseHeaders = new Headers(baseInit.headers);
  baseHeaders.set('content-type', baseHeaders.get('content-type') ?? 'application/json');
  const result = await args.hook({
    url: args.url,
    method: (baseInit.method ?? 'POST').toUpperCase(),
    headers: baseHeaders,
    body: args.body,
    provider: args.providerTag,
  });
  if (!result?.headers) return baseInit;
  const merged = new Headers(baseHeaders);
  for (const [k, v] of Object.entries(result.headers)) merged.set(k, v);
  merged.delete('content-length');
  return { ...baseInit, headers: merged };
};

const cloneInitWithBody = (init: RequestInit | undefined, body: string): RequestInit => {
  const out: RequestInit = { ...(init ?? {}), body };
  if (out.headers) {
    const h = new Headers(out.headers);
    h.delete('content-length');
    out.headers = h;
  }
  return out;
};

const emitToolCalls = async (
  bus: EventBus,
  ids: AgentIds,
  calls: ToolCall[],
  state: InterceptorState,
): Promise<void> => {
  for (const call of calls) {
    const callIds: AgentIds = { ...ids, callId: call.id };
    const result = await bus.emit({
      type: 'tool.call.requested',
      ts: Date.now(),
      ids: callIds,
      source: 'l1',
      call,
    });
    if (result.denied) {
      state.deniedCalls.set(call.id, result.denied.reason);
      const denyEvt: AgentEvent = {
        type: 'tool.call.denied',
        ts: Date.now(),
        ids: callIds,
        source: 'l1',
        call,
        reason: result.denied.reason,
        ...(result.denied.policyId ? { policyId: result.denied.policyId } : {}),
      };
      await bus.emit(denyEvt);
    }
  }
};

const emitTurnEnd = async (
  ctx: InternalCtx,
  ids: AgentIds,
  startMs: number,
  provider: ProviderImpl,
  res: unknown,
  opts: { skipCallIds?: readonly string[]; aborted?: boolean } = {},
): Promise<void> => {
  const turnEnd: AgentEvent = {
    type: 'turn.end',
    ts: Date.now(),
    ids,
    source: 'l1',
    durationMs: Date.now() - startMs,
    response: provider.normalizeResponse(res),
    ...(ctx.includeRaw ? { raw: res } : {}),
  };
  await ctx.bus.emit(turnEnd);

  const usage = provider.extractUsage(res);
  if (usage) {
    await ctx.bus.emit({
      type: 'usage',
      ts: Date.now(),
      ids,
      source: 'l1',
      usage,
    });
  }

  // If we're here after a mid-stream abort, we don't want to re-emit calls
  // that were already eagerly emitted (and possibly denied). Filter those out.
  const skip = new Set(opts.skipCallIds ?? []);
  const remaining = provider.extractToolCalls(res).filter((c) => !skip.has(c.id));
  await emitToolCalls(ctx.bus, ids, remaining, ctx.state);
};

export const installFetchInterceptor = (opts: FetchInterceptorOptions): (() => void) => {
  const target: { fetch: typeof fetch } = opts.target ?? (globalThis as { fetch: typeof fetch });
  const original: typeof fetch = target.fetch.bind(target);

  const enabled = new Set<ProviderTag>(opts.providers ?? BUILTIN_PROVIDERS.map((p) => p.tag));
  const detectOpts: ProviderDetectOpts = { customHosts: opts.customHosts ?? {} };

  const persistentSessionId = createSessionId();
  const sessionIdResolver = opts.getSessionId ?? (() => persistentSessionId);

  const ctx: InternalCtx = {
    bus: opts.bus,
    state: createState(),
    includeRaw: opts.includeRaw ?? false,
    redact: opts.redactHeaders ?? 'standard',
  };

  const findProvider = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): ProviderImpl | undefined => {
    for (const p of BUILTIN_PROVIDERS) {
      if (!enabled.has(p.tag)) continue;
      if (p.detect(input, init, detectOpts)) return p;
    }
    return undefined;
  };

  const wrapped: typeof fetch = async (input, init) => {
    const provider = findProvider(input, init);
    if (!provider) return original(input, init);

    let url: URL;
    try {
      url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
    } catch {
      return original(input, init);
    }

    const body = readJsonBody(init);
    const parsed = provider.parseRequest(body, { url });
    if (parsed === undefined) return original(input, init);

    const ids: AgentIds = { sessionId: sessionIdResolver(), turnId: createTurnId() };

    const { rewritten, rewroteIds } = provider.applyDeny(parsed, ctx.state.deniedCalls);
    for (const id of rewroteIds) ctx.state.deniedCalls.delete(id);
    let outgoing: unknown = rewritten;
    if (opts.rewriteToolResults && provider.applyContentRewrites) {
      const composed = composeRewriters(
        opts.rewriteToolResults,
        ctx.bus,
        provider.tag,
      );
      const result = provider.applyContentRewrites(outgoing, composed);
      outgoing = result.rewritten;
    }

    const startEvt: AgentEvent = {
      type: 'turn.start',
      ts: Date.now(),
      ids,
      source: 'l1',
      provider: provider.tag,
      model: provider.getModel(outgoing),
      request: provider.normalizeRequest(outgoing),
      ...(ctx.includeRaw
        ? { raw: { body: outgoing, headers: redactHeaders(init?.headers, ctx.redact) } }
        : {}),
    };
    await ctx.bus.emit(startEvt);

    const startMs = Date.now();
    const serializedBody = provider.serializeRequest(outgoing);
    const signedInit = await applySignRequest({
      init,
      body: serializedBody,
      url: url.toString(),
      providerTag: provider.tag,
      hook: opts.signRequest,
    });
    let response: Response;
    try {
      response = await original(input, signedInit);
    } catch (err) {
      await ctx.bus.emit({
        type: 'error',
        ts: Date.now(),
        ids,
        source: 'l1',
        message: err instanceof Error ? err.message : String(err),
        stage: 'turn.start',
        cause: err,
      });
      throw err;
    }

    const isStream =
      provider.isStreamRequest(outgoing) ||
      response.headers.get('content-type')?.startsWith('text/event-stream') === true;

    if (isStream && response.body) {
      // Manual fan-out instead of tee — tee locks the source so we can't
      // cancel it. With a direct reader, calling sourceReader.cancel() in
      // the deny path propagates to the upstream HTTP connection and the
      // model stops generating.
      const sourceReader = response.body.getReader();
      const hostPipe = new TransformStream<Uint8Array, Uint8Array>();
      const tapPipe = new TransformStream<Uint8Array, Uint8Array>();
      const hostWriter = hostPipe.writable.getWriter();
      const tapWriter = tapPipe.writable.getWriter();

      let aborted = false;
      // Pump source → host + tap. Closes both writers on EOF or on abort.
      void (async () => {
        try {
          while (!aborted) {
            const { done, value } = await sourceReader.read();
            if (done) break;
            await Promise.all([
              hostWriter.write(value).catch(() => undefined),
              tapWriter.write(value).catch(() => undefined),
            ]);
          }
        } catch {
          // Reader cancellation throws — fall through to close
        } finally {
          await hostWriter.close().catch(() => undefined);
          await tapWriter.close().catch(() => undefined);
        }
      })();

      void (async () => {
        const {
          response: assembled,
          errored,
          eagerlyEmittedCallIds,
          aborted: streamAborted,
        } = await provider.consumeStream(tapPipe.readable, {
          onToolCall: async (call) => {
            const callIds: AgentIds = { ...ids, callId: call.id };
            const decision = await ctx.bus.emit({
              type: 'tool.call.requested',
              ts: Date.now(),
              ids: callIds,
              source: 'l1',
              call,
            });
            if (decision.denied) {
              ctx.state.deniedCalls.set(call.id, decision.denied.reason);
              await ctx.bus.emit({
                type: 'tool.call.denied',
                ts: Date.now(),
                ids: callIds,
                source: 'l1',
                call,
                reason: decision.denied.reason,
                ...(decision.denied.policyId ? { policyId: decision.denied.policyId } : {}),
              });
              // Mark abort flag and cancel the upstream connection. The
              // pump loop sees `aborted` and stops; sourceReader.cancel()
              // tells the network layer to close the connection so the
              // model server stops generating.
              aborted = true;
              await sourceReader.cancel().catch(() => undefined);
              return { abort: true };
            }
            return { abort: false };
          },
        });
        // Use the local-scope `streamAborted` (returned by consumeStream)
        // to feed the skip filter; `aborted` (outer var) tracks pump state.
        void streamAborted;
        if (errored) {
          await ctx.bus.emit({
            type: 'error',
            ts: Date.now(),
            ids,
            source: 'l1',
            message: errored.message,
            stage: 'turn.end',
            cause: errored,
          });
        }
        await emitTurnEnd(ctx, ids, startMs, provider, assembled, {
          ...(eagerlyEmittedCallIds ? { skipCallIds: eagerlyEmittedCallIds } : {}),
          aborted,
        });
      })();
      return new Response(hostPipe.readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const text = await response.text();
    const parsedRes = provider.parseResponseText(text);
    if (parsedRes === undefined) {
      await ctx.bus.emit({
        type: 'error',
        ts: Date.now(),
        ids,
        source: 'l1',
        message: 'failed to parse non-streaming response',
        stage: 'turn.end',
      });
    } else {
      await emitTurnEnd(ctx, ids, startMs, provider, parsedRes);
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  target.fetch = wrapped;
  return () => {
    target.fetch = original;
  };
};
