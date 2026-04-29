import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  createCallId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';

/**
 * Minimal subset of LangChain's BaseCallbackHandlerInput we touch. Mirrors
 * the @langchain/core BaseCallbackHandler shape so this package can be used
 * without taking a hard dep on it.
 */
export interface LangChainCallbackHandler {
  name?: string;
  handleLLMStart?(
    llm: unknown,
    prompts: string[] | unknown[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> | void;
  handleLLMEnd?(
    output: { llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } } },
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> | void;
  handleLLMError?(err: unknown, runId: string, parentRunId?: string): Promise<void> | void;
  handleToolStart?(
    tool: { name?: string; lc_serializable?: boolean } | unknown,
    input: string | unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> | void;
  handleToolEnd?(
    output: string | unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
  ): Promise<void> | void;
  handleToolError?(err: unknown, runId: string, parentRunId?: string): Promise<void> | void;
  handleChainStart?(
    chain: { name?: string } | unknown,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
  ): Promise<void> | void;
  handleChainEnd?(
    outputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
  ): Promise<void> | void;
}

export interface HarnesskitCallbacksOptions {
  bus: EventBus;
  /** Optional sessionId resolver. Default: one fresh sessionId at create. */
  sessionId?: () => string;
}

const safeStringify = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const parseInput = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * Returns a LangChain-compatible callback handler that emits harnesskit
 * AgentEvents. Pass it via `{ callbacks: [harnesskitCallbacks({ bus })] }`
 * to any Runnable (Chain, Agent, StateGraph node, etc).
 *
 * Maps:
 *   handleLLMStart  → turn.start
 *   handleLLMEnd    → turn.end + usage
 *   handleToolStart → tool.call.requested
 *   handleToolEnd   → tool.call.resolved
 *
 * Note: tool denial via this path is best-effort. LangChain will execute the
 * tool regardless of what handleToolStart does. For hard prevention, deny
 * via the underlying L1 fetch interceptor (which catches the model's tool
 * call before LangChain dispatches the tool).
 */
export const harnesskitCallbacks = (opts: HarnesskitCallbacksOptions): LangChainCallbackHandler => {
  let cachedSessionId: string | undefined;
  const resolveSession = (): string => {
    if (opts.sessionId) return opts.sessionId();
    if (!cachedSessionId) cachedSessionId = createSessionId();
    return cachedSessionId;
  };

  // Map LangChain runId → our turn/call ids so resolves match starts.
  const turnByRun = new Map<string, { turnId: string; startMs: number; model?: string }>();
  const callByRun = new Map<
    string,
    { callId: string; turnId: string; name: string; input: unknown; startMs: number }
  >();

  return {
    name: 'harnesskit-callbacks',

    async handleLLMStart(llm, _prompts, runId) {
      const sessionId = resolveSession();
      const turnId = createTurnId();
      const llmObj = llm as { id?: string[]; lc_kwargs?: { model?: string; modelName?: string } };
      const model = llmObj?.lc_kwargs?.model ?? llmObj?.lc_kwargs?.modelName ?? 'unknown';
      turnByRun.set(runId, { turnId, startMs: Date.now(), model });
      const evt: AgentEvent = {
        type: 'turn.start',
        ts: Date.now(),
        ids: { sessionId, turnId },
        source: 'l2',
        provider: 'unknown',
        model,
        request: { messages: [] },
      };
      await opts.bus.emit(evt);
    },

    async handleLLMEnd(output, runId) {
      const turn = turnByRun.get(runId);
      if (!turn) return;
      const sessionId = resolveSession();
      await opts.bus.emit({
        type: 'turn.end',
        ts: Date.now(),
        ids: { sessionId, turnId: turn.turnId },
        source: 'l2',
        durationMs: Date.now() - turn.startMs,
        response: { content: [] },
      });
      const usage = output?.llmOutput?.tokenUsage;
      if (usage) {
        await opts.bus.emit({
          type: 'usage',
          ts: Date.now(),
          ids: { sessionId, turnId: turn.turnId },
          source: 'l2',
          usage: {
            ...(usage.promptTokens !== undefined ? { inputTokens: usage.promptTokens } : {}),
            ...(usage.completionTokens !== undefined
              ? { outputTokens: usage.completionTokens }
              : {}),
          },
        });
      }
      turnByRun.delete(runId);
    },

    async handleLLMError(err, runId) {
      const turn = turnByRun.get(runId);
      if (!turn) return;
      const sessionId = resolveSession();
      await opts.bus.emit({
        type: 'error',
        ts: Date.now(),
        ids: { sessionId, turnId: turn.turnId },
        source: 'l2',
        message: err instanceof Error ? err.message : String(err),
        stage: 'turn.end',
        cause: err,
      });
      turnByRun.delete(runId);
    },

    async handleToolStart(tool, input, runId, parentRunId) {
      const sessionId = resolveSession();
      const t = tool as { name?: string };
      const callId = createCallId();
      const turnId = parentRunId
        ? (turnByRun.get(parentRunId)?.turnId ?? createTurnId())
        : createTurnId();
      const parsed = parseInput(input);
      callByRun.set(runId, {
        callId,
        turnId,
        name: t?.name ?? 'tool',
        input: parsed,
        startMs: Date.now(),
      });
      const ids: AgentIds = { sessionId, turnId, callId };
      await opts.bus.emit({
        type: 'tool.call.requested',
        ts: Date.now(),
        ids,
        source: 'l2',
        call: { id: callId, name: t?.name ?? 'tool', input: parsed },
      });
    },

    async handleToolEnd(output, runId) {
      const call = callByRun.get(runId);
      if (!call) return;
      const sessionId = resolveSession();
      await opts.bus.emit({
        type: 'tool.call.resolved',
        ts: Date.now(),
        ids: { sessionId, turnId: call.turnId, callId: call.callId },
        source: 'l2',
        call: { id: call.callId, name: call.name, input: call.input },
        result: { content: safeStringify(output), durationMs: Date.now() - call.startMs },
      });
      callByRun.delete(runId);
    },

    async handleToolError(err, runId) {
      const call = callByRun.get(runId);
      if (!call) return;
      const sessionId = resolveSession();
      await opts.bus.emit({
        type: 'tool.call.resolved',
        ts: Date.now(),
        ids: { sessionId, turnId: call.turnId, callId: call.callId },
        source: 'l2',
        call: { id: call.callId, name: call.name, input: call.input },
        result: {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
          durationMs: Date.now() - call.startMs,
        },
      });
      callByRun.delete(runId);
    },
  };
};
