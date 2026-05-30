import {
  type AgentEvent,
  type AgentIds,
  EventBus,
  type EventSource,
  type Interceptor,
  type NormalizedContent,
  type Policy,
  type ToolCall,
  createCallId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import { type Trace, TraceRecorder } from '@harnesskit/eval';
import { policyToInterceptor } from '@harnesskit/policy';
import { type FetchInterceptorOptions, installFetchInterceptor } from '@harnesskit/provider-fetch';

export interface HarnessTool<
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> {
  description?: string;
  parameters?: unknown;
  execute: (args: Args) => Result | Promise<Result>;
}

export interface HarnessToolContext {
  sessionId?: string;
  turnId?: string;
  callId?: string;
  agentPath?: readonly string[];
  source?: EventSource;
}

export type WrappedHarnessTool<
  Args extends Record<string, unknown> = Record<string, unknown>,
  Result = unknown,
> = Omit<HarnessTool<Args, Result>, 'execute'> & {
  execute: (args: Args, context?: HarnessToolContext) => Promise<Result>;
};

export type HarnessToolMap = Record<string, HarnessTool<Record<string, unknown>, unknown>>;

export type WrappedHarnessTools<Tools extends HarnessToolMap> = {
  readonly [Name in keyof Tools]: Tools[Name] extends HarnessTool<infer Args, infer Result>
    ? WrappedHarnessTool<Args, Result>
    : never;
};

export interface CreateHarnessOptions {
  bus?: EventBus;
  /**
   * Dispose the bus when `harness.dispose()` is called. Defaults to true for
   * internally-created buses, false for caller-owned buses.
   */
  disposeBus?: boolean;
  policies?: readonly Policy[];
  interceptors?: readonly Interceptor[];
  /** Attach a TraceRecorder. Defaults to true for the high-level SDK facade. */
  recorder?: boolean | TraceRecorder;
  /** Keep an in-memory list of every event. Defaults to true. */
  collectEvents?: boolean;
  /** Install L1 fetch interception immediately. Defaults to false. */
  fetch?: boolean | Omit<FetchInterceptorOptions, 'bus'>;
  /** Stable session id for SDK-emitted L2 events. */
  sessionId?: string;
  /** Source for SDK-emitted tool/session events. Defaults to l2. */
  source?: EventSource;
}

export interface Harness {
  readonly bus: EventBus;
  readonly sessionId: string;
  readonly events: readonly AgentEvent[];
  readonly recorder?: TraceRecorder;
  usePolicy: (policy: Policy) => void;
  useInterceptor: (interceptor: Interceptor) => void;
  installFetch: (options?: Omit<FetchInterceptorOptions, 'bus'>) => () => void;
  startSession: (meta?: Record<string, unknown>) => Promise<void>;
  endSession: (reason?: 'complete' | 'error' | 'abort') => Promise<void>;
  wrapTool: <Args extends Record<string, unknown>, Result>(
    name: string,
    tool: HarnessTool<Args, Result>,
  ) => WrappedHarnessTool<Args, Result>;
  wrapTools: <Tools extends HarnessToolMap>(tools: Tools) => WrappedHarnessTools<Tools>;
  getTrace: () => Trace | undefined;
  allTraces: () => readonly Trace[];
  dispose: () => Promise<void>;
}

interface HarnessToolDeniedErrorInput {
  toolName: string;
  reason: string;
  policyId?: string;
}

export class HarnessToolDeniedError extends Error {
  readonly toolName: string;
  readonly reason: string;
  readonly policyId?: string;

  constructor(input: HarnessToolDeniedErrorInput) {
    super(`[harnesskit denied] ${input.toolName}: ${input.reason}`);
    this.name = 'HarnessToolDeniedError';
    this.toolName = input.toolName;
    this.reason = input.reason;
    if (input.policyId !== undefined) this.policyId = input.policyId;
  }
}

const toToolResultContent = (value: unknown): string | NormalizedContent[] => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const idsForTool = (sessionId: string, context: HarnessToolContext | undefined): AgentIds => {
  const ids: AgentIds = {
    sessionId: context?.sessionId ?? sessionId,
    turnId: context?.turnId ?? createTurnId(),
  };
  if (context?.callId !== undefined) ids.callId = context.callId;
  if (context?.agentPath !== undefined) ids.agentPath = context.agentPath;
  return ids;
};

export const createHarness = (options: CreateHarnessOptions = {}): Harness => {
  const bus = options.bus ?? new EventBus();
  const disposeBus = options.disposeBus ?? options.bus === undefined;
  const source = options.source ?? 'l2';
  const sessionId = options.sessionId ?? createSessionId();
  const events: AgentEvent[] = [];
  const fetchDisposers: Array<() => void> = [];

  const useInterceptor = (interceptor: Interceptor): void => {
    bus.use(interceptor);
  };

  const usePolicy = (policy: Policy): void => {
    useInterceptor(policyToInterceptor(policy));
  };

  if (options.collectEvents ?? true) {
    useInterceptor({
      name: 'harnesskit-sdk-collector',
      on: (event) => {
        events.push(event);
      },
    });
  }

  for (const policy of options.policies ?? []) usePolicy(policy);
  for (const interceptor of options.interceptors ?? []) useInterceptor(interceptor);

  let recorder: TraceRecorder | undefined;
  if (options.recorder === false) {
    recorder = undefined;
  } else if (options.recorder instanceof TraceRecorder) {
    recorder = options.recorder;
    useInterceptor(recorder);
  } else {
    recorder = new TraceRecorder();
    useInterceptor(recorder);
  }

  const installFetch = (fetchOptions: Omit<FetchInterceptorOptions, 'bus'> = {}): (() => void) => {
    const resolvedOptions: Omit<FetchInterceptorOptions, 'bus'> = fetchOptions.getSessionId
      ? fetchOptions
      : { ...fetchOptions, getSessionId: () => sessionId };
    const dispose = installFetchInterceptor({ ...resolvedOptions, bus });
    fetchDisposers.push(dispose);
    return dispose;
  };

  if (options.fetch === true) {
    installFetch();
  } else if (options.fetch && typeof options.fetch === 'object') {
    installFetch(options.fetch);
  }

  const startSession = async (meta?: Record<string, unknown>): Promise<void> => {
    await bus.emit({
      type: 'session.start',
      ts: Date.now(),
      ids: { sessionId, turnId: createTurnId() },
      source,
      ...(meta ? { meta } : {}),
    });
  };

  const endSession = async (reason: 'complete' | 'error' | 'abort' = 'complete'): Promise<void> => {
    await bus.emit({
      type: 'session.end',
      ts: Date.now(),
      ids: { sessionId, turnId: createTurnId() },
      source,
      reason,
    });
  };

  const wrapTool = <Args extends Record<string, unknown>, Result>(
    name: string,
    tool: HarnessTool<Args, Result>,
  ): WrappedHarnessTool<Args, Result> => {
    return {
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
      execute: async (args, context) => {
        const ids = idsForTool(sessionId, context);
        const callId = ids.callId ?? createCallId();
        ids.callId = callId;
        const call: ToolCall = { id: callId, name, input: args };
        const eventSource = context?.source ?? source;

        const decision = await bus.emit({
          type: 'tool.call.requested',
          ts: Date.now(),
          ids,
          source: eventSource,
          call,
        });

        if (decision.denied) {
          await bus.emit({
            type: 'tool.call.denied',
            ts: Date.now(),
            ids,
            source: eventSource,
            call,
            reason: decision.denied.reason,
            ...(decision.denied.policyId ? { policyId: decision.denied.policyId } : {}),
          });
          throw new HarnessToolDeniedError({
            toolName: name,
            reason: decision.denied.reason,
            ...(decision.denied.policyId ? { policyId: decision.denied.policyId } : {}),
          });
        }

        const startedAt = Date.now();
        try {
          const result = await tool.execute(args);
          await bus.emit({
            type: 'tool.call.resolved',
            ts: Date.now(),
            ids,
            source: eventSource,
            call,
            result: {
              content: toToolResultContent(result),
              durationMs: Date.now() - startedAt,
            },
          });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await bus.emit({
            type: 'tool.call.resolved',
            ts: Date.now(),
            ids,
            source: eventSource,
            call,
            result: {
              content: message,
              isError: true,
              durationMs: Date.now() - startedAt,
            },
          });
          await bus.emit({
            type: 'error',
            ts: Date.now(),
            ids,
            source: eventSource,
            message,
            stage: 'tool.call',
            cause: err,
          });
          throw err;
        }
      },
    };
  };

  const wrapTools = <Tools extends HarnessToolMap>(tools: Tools): WrappedHarnessTools<Tools> => {
    const wrapped = {} as { [Name in keyof Tools]: WrappedHarnessTools<Tools>[Name] };
    for (const [name, tool] of Object.entries(tools) as Array<
      [keyof Tools & string, Tools[keyof Tools]]
    >) {
      wrapped[name] = wrapTool(name, tool) as WrappedHarnessTools<Tools>[typeof name];
    }
    return wrapped;
  };

  const getTrace = (): Trace | undefined => recorder?.getTrace(sessionId);
  const allTraces = (): readonly Trace[] => recorder?.allTraces() ?? [];

  const dispose = async (): Promise<void> => {
    for (const disposeFetch of [...fetchDisposers].reverse()) disposeFetch();
    fetchDisposers.length = 0;
    if (disposeBus) await bus.dispose();
  };

  return {
    bus,
    sessionId,
    events,
    ...(recorder ? { recorder } : {}),
    usePolicy,
    useInterceptor,
    installFetch,
    startSession,
    endSession,
    wrapTool,
    wrapTools,
    getTrace,
    allTraces,
    dispose,
  };
};
