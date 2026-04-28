import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  type Provider,
  createCallId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import type {
  StepResultLike,
  StepToolCallLike,
  StepToolResultLike,
  ToolCallContextLike,
  ToolLike,
  VercelAiOptionsLike,
} from './types.js';

export type {
  StepResultLike,
  ToolLike,
  ToolCallContextLike,
  VercelAiOptionsLike,
} from './types.js';

export interface VercelAiAdapterOptions {
  bus: EventBus;
  /** Resolves the sessionId. Default: generates one at attach time. */
  fallbackSessionId?: () => string;
}

const mapProvider = (vercelProvider: string | undefined): Provider => {
  if (!vercelProvider) return 'unknown';
  const lower = vercelProvider.toLowerCase();
  if (lower.startsWith('anthropic')) return 'anthropic';
  if (lower.includes('openai') && lower.includes('responses')) return 'openai-responses';
  if (lower.startsWith('openai')) return 'openai';
  if (lower.startsWith('google') || lower.startsWith('gemini')) return 'google';
  if (lower.includes('openrouter')) return 'openrouter';
  return 'unknown';
};

const stringifyResult = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

const wrapTool = (
  toolName: string,
  tool: ToolLike,
  bus: EventBus,
  sessionId: () => string,
): ToolLike => {
  const origExecute = tool.execute;
  if (!origExecute) return tool;
  return {
    ...tool,
    execute: async (input: unknown, ctx: ToolCallContextLike) => {
      const callId = ctx.toolCallId ?? createCallId();
      const name = ctx.toolName ?? toolName;
      const ids: AgentIds = {
        sessionId: sessionId(),
        turnId: createTurnId(),
        callId,
      };
      const decision = await bus.emit({
        type: 'tool.call.requested',
        ts: Date.now(),
        ids,
        source: 'l2',
        call: { id: callId, name, input },
      });
      if (decision.denied) {
        const denyEvt: AgentEvent = {
          type: 'tool.call.denied',
          ts: Date.now(),
          ids,
          source: 'l2',
          call: { id: callId, name, input },
          reason: decision.denied.reason,
          ...(decision.denied.policyId ? { policyId: decision.denied.policyId } : {}),
        };
        await bus.emit(denyEvt);
        throw new Error(`[harnesskit denied] ${decision.denied.reason}`);
      }
      return origExecute(input, ctx);
    },
  };
};

const findCallInput = (
  result: StepToolResultLike,
  calls: StepToolCallLike[] | undefined,
): unknown => {
  if (!calls) return {};
  return calls.find((c) => c.toolCallId === result.toolCallId)?.input ?? {};
};

export const withHarnesskit = <T extends VercelAiOptionsLike>(
  busOrOpts: EventBus | VercelAiAdapterOptions,
  options: T,
): T => {
  const adapterOpts: VercelAiAdapterOptions =
    'bus' in busOrOpts ? busOrOpts : { bus: busOrOpts as EventBus };

  let cachedSessionId: string | undefined;
  const sessionId = (): string => {
    if (!cachedSessionId) {
      cachedSessionId = adapterOpts.fallbackSessionId?.() ?? createSessionId();
    }
    return cachedSessionId;
  };

  const wrappedTools = options.tools
    ? Object.fromEntries(
        Object.entries(options.tools).map(([name, t]) => [
          name,
          wrapTool(name, t, adapterOpts.bus, sessionId),
        ]),
      )
    : undefined;

  let sessionStarted = false;
  const origStep = options.onStepFinish;
  const wrappedStep = async (step: StepResultLike) => {
    const sid = sessionId();
    if (!sessionStarted) {
      sessionStarted = true;
      await adapterOpts.bus.emit({
        type: 'session.start',
        ts: Date.now(),
        ids: { sessionId: sid, turnId: createTurnId() },
        source: 'l2',
      });
    }

    const turnId = createTurnId();
    const provider = mapProvider(step.model?.provider);

    await adapterOpts.bus.emit({
      type: 'turn.start',
      ts: Date.now(),
      ids: { sessionId: sid, turnId },
      source: 'l2',
      provider,
      model: step.model?.modelId ?? 'unknown',
      request: { messages: [] },
    });

    const turnEnd: AgentEvent = {
      type: 'turn.end',
      ts: Date.now(),
      ids: { sessionId: sid, turnId },
      source: 'l2',
      durationMs: 0,
      response: {
        content: step.text ? [{ type: 'text', text: step.text }] : [],
        ...(step.finishReason ? { stopReason: step.finishReason } : {}),
      },
    };
    await adapterOpts.bus.emit(turnEnd);

    if (step.usage) {
      const usageEvt: AgentEvent = {
        type: 'usage',
        ts: Date.now(),
        ids: { sessionId: sid, turnId },
        source: 'l2',
        usage: {
          ...(step.usage.inputTokens !== undefined ? { inputTokens: step.usage.inputTokens } : {}),
          ...(step.usage.outputTokens !== undefined
            ? { outputTokens: step.usage.outputTokens }
            : {}),
          ...(step.usage.cachedInputTokens !== undefined
            ? { cacheReadTokens: step.usage.cachedInputTokens }
            : {}),
        },
      };
      await adapterOpts.bus.emit(usageEvt);
    }

    for (const tr of step.toolResults ?? []) {
      const callIds: AgentIds = {
        sessionId: sid,
        turnId,
        callId: tr.toolCallId,
      };
      const inputForCall = findCallInput(tr, step.toolCalls);
      const out = tr.output ?? tr.result;
      await adapterOpts.bus.emit({
        type: 'tool.call.resolved',
        ts: Date.now(),
        ids: callIds,
        source: 'l2',
        call: { id: tr.toolCallId, name: tr.toolName ?? 'unknown', input: inputForCall },
        result: { content: stringifyResult(out) },
      });
    }

    if (origStep) await origStep(step);
  };

  const origFinish = options.onFinish;
  const wrappedFinish = async (event: unknown) => {
    await adapterOpts.bus.emit({
      type: 'session.end',
      ts: Date.now(),
      ids: { sessionId: sessionId(), turnId: createTurnId() },
      source: 'l2',
      reason: 'complete',
    });
    if (origFinish) await origFinish(event);
  };

  return {
    ...options,
    ...(wrappedTools ? { tools: wrappedTools } : {}),
    onStepFinish: wrappedStep,
    onFinish: wrappedFinish,
  };
};
