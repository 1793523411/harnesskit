import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  type ToolCall,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import { anthropicProvider } from './providers/anthropic/index.js';
import { openaiResponsesProvider } from './providers/openai-responses/index.js';
import { openaiProvider, openrouterProvider } from './providers/openai/index.js';
import type { ProviderDetectOpts, ProviderImpl, ProviderTag } from './providers/types.js';
import { type RedactOption, redactHeaders } from './redact.js';
import { type InterceptorState, createState } from './state.js';

export type { ProviderTag } from './providers/types.js';

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
}

const BUILTIN_PROVIDERS: readonly ProviderImpl[] = [
  anthropicProvider,
  openaiResponsesProvider,
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

  await emitToolCalls(ctx.bus, ids, provider.extractToolCalls(res), ctx.state);
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

    const body = readJsonBody(init);
    const parsed = provider.parseRequest(body);
    if (parsed === undefined) return original(input, init);

    const ids: AgentIds = { sessionId: sessionIdResolver(), turnId: createTurnId() };

    const { rewritten, rewroteIds } = provider.applyDeny(parsed, ctx.state.deniedCalls);
    for (const id of rewroteIds) ctx.state.deniedCalls.delete(id);
    const outgoing = rewritten;

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
    let response: Response;
    try {
      response = await original(
        input,
        cloneInitWithBody(init, provider.serializeRequest(outgoing)),
      );
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
      const [forHost, forUs] = response.body.tee();
      void (async () => {
        const { response: assembled, errored } = await provider.consumeStream(forUs);
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
        await emitTurnEnd(ctx, ids, startMs, provider, assembled);
      })();
      return new Response(forHost, {
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
