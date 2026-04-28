import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  createCallId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import type { AgentLike, RunHooksLike, ToolCallItemLike, ToolLike } from './types.js';

export type { RunHooksLike, ToolCallItemLike, ToolLike, AgentLike } from './types.js';

export interface OpenAIAgentsAdapterOptions {
  bus: EventBus;
  /** A `RunHooks` instance from @openai/agents (e.g. `runner.runHooks`). */
  runHooks: RunHooksLike;
  /** Resolves the sessionId. Default: generates one at attach time. */
  fallbackSessionId?: () => string;
}

const extractToolName = (tool: ToolLike, call: ToolCallItemLike): string => {
  if (typeof tool?.name === 'string') return tool.name;
  if (typeof call?.name === 'string') return call.name;
  return 'unknown';
};

const extractAgentName = (agent: AgentLike): string =>
  typeof agent?.name === 'string' ? agent.name : 'agent';

const stringifyResult = (result: unknown): string =>
  typeof result === 'string' ? result : JSON.stringify(result);

export const attachOpenAIAgentsAdapter = (opts: OpenAIAgentsAdapterOptions): (() => void) => {
  let cachedSessionId: string | undefined;
  const sessionId = (): string => {
    if (!cachedSessionId) {
      cachedSessionId = opts.fallbackSessionId?.() ?? createSessionId();
    }
    return cachedSessionId;
  };

  let sessionStarted = false;
  const cleanups: (() => void)[] = [];

  // Serialize emits — the host EventEmitter doesn't await listeners, so we need
  // to chain them ourselves to preserve event order across rapid-fire hooks.
  let queue: Promise<unknown> = Promise.resolve();
  const fire = (event: AgentEvent): void => {
    queue = queue.then(() => opts.bus.emit(event)).catch(() => {});
  };

  const onAgentStart: (...args: unknown[]) => void = (_ctx, agent) => {
    const sid = sessionId();
    if (!sessionStarted) {
      sessionStarted = true;
      fire({
        type: 'session.start',
        ts: Date.now(),
        ids: { sessionId: sid, turnId: createTurnId() },
        source: 'l2',
        meta: { agent: extractAgentName(agent as AgentLike) },
      });
    }
  };

  const onAgentHandoff: (...args: unknown[]) => void = (_ctx, _from, to) => {
    const sid = sessionId();
    const childSid = createSessionId();
    fire({
      type: 'subagent.spawn',
      ts: Date.now(),
      ids: { sessionId: sid, turnId: createTurnId() },
      source: 'l2',
      parentSessionId: sid,
      childSessionId: childSid,
      purpose: extractAgentName(to as AgentLike),
    });
  };

  const onAgentToolStart: (...args: unknown[]) => void = (_ctx, _agent, tool, details) => {
    const t = tool as ToolLike;
    const d = (details as { toolCall?: ToolCallItemLike }) ?? {};
    const call = d.toolCall ?? {};
    const callId = call.id ?? createCallId();
    const ids: AgentIds = {
      sessionId: sessionId(),
      turnId: createTurnId(),
      callId,
    };
    fire({
      type: 'tool.call.requested',
      ts: Date.now(),
      ids,
      source: 'l2',
      call: {
        id: callId,
        name: extractToolName(t, call),
        input: call.arguments ?? {},
      },
    });
  };

  const onAgentToolEnd: (...args: unknown[]) => void = (_ctx, _agent, tool, result, details) => {
    const t = tool as ToolLike;
    const d = (details as { toolCall?: ToolCallItemLike }) ?? {};
    const call = d.toolCall ?? {};
    const callId = call.id ?? 'unknown';
    const ids: AgentIds = {
      sessionId: sessionId(),
      turnId: createTurnId(),
      callId,
    };
    fire({
      type: 'tool.call.resolved',
      ts: Date.now(),
      ids,
      source: 'l2',
      call: {
        id: callId,
        name: extractToolName(t, call),
        input: call.arguments ?? {},
      },
      result: { content: stringifyResult(result) },
    });
  };

  const bindings: [string, (...args: unknown[]) => void][] = [
    ['agent_start', onAgentStart],
    ['agent_handoff', onAgentHandoff],
    ['agent_tool_start', onAgentToolStart],
    ['agent_tool_end', onAgentToolEnd],
  ];

  for (const [name, handler] of bindings) {
    opts.runHooks.on(name, handler);
    cleanups.push(() => opts.runHooks.off(name, handler));
  }

  return () => {
    for (const c of cleanups) c();
  };
};
