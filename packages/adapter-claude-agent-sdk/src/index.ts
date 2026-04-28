import {
  type AgentEvent,
  type AgentIds,
  type EventBus,
  createCallId,
  createPendingId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import type {
  CanUseTool,
  ClaudeAgentSdkOptions,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  PermissionResult,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from './types.js';

export type {
  ClaudeAgentSdkOptions,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  PermissionResult,
} from './types.js';

export interface WithHarnesskitOptions {
  bus: EventBus;
  /** Resolves the sessionId for events that the SDK didn't already provide one for. */
  fallbackSessionId?: () => string;
}

const isPreToolUse = (i: HookInput): i is PreToolUseHookInput => i.hook_event_name === 'PreToolUse';
const isPostToolUse = (i: HookInput): i is PostToolUseHookInput =>
  i.hook_event_name === 'PostToolUse';
const isSubagentStart = (i: HookInput): i is SubagentStartHookInput =>
  i.hook_event_name === 'SubagentStart';
const isSubagentStop = (i: HookInput): i is SubagentStopHookInput =>
  i.hook_event_name === 'SubagentStop';

const buildIds = (input: HookInput, fallbackSessionId: () => string, callId?: string): AgentIds => {
  const sessionId = input.session_id ?? fallbackSessionId();
  const turnId = createTurnId();
  return callId ? { sessionId, turnId, callId } : { sessionId, turnId };
};

const makeObserverHook =
  (bus: EventBus, eventName: HookEvent, fallbackSessionId: () => string): HookCallback =>
  async (input, toolUseID) => {
    switch (eventName) {
      case 'PreToolUse': {
        if (!isPreToolUse(input)) return {};
        const callId = toolUseID ?? input.tool_use_id;
        const ids = buildIds(input, fallbackSessionId, callId);
        const result = await bus.emit({
          type: 'tool.call.requested',
          ts: Date.now(),
          ids,
          source: 'l2',
          call: { id: callId, name: input.tool_name, input: input.tool_input },
        });
        if (result.denied) {
          await bus.emit({
            type: 'tool.call.denied',
            ts: Date.now(),
            ids,
            source: 'l2',
            call: { id: callId, name: input.tool_name, input: input.tool_input },
            reason: result.denied.reason,
            ...(result.denied.policyId ? { policyId: result.denied.policyId } : {}),
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: result.denied.reason,
            },
          };
        }
        return {};
      }
      case 'PostToolUse': {
        if (!isPostToolUse(input)) return {};
        const callId = toolUseID ?? input.tool_use_id;
        const ids = buildIds(input, fallbackSessionId, callId);
        const content =
          typeof input.tool_response === 'string'
            ? input.tool_response
            : JSON.stringify(input.tool_response);
        await bus.emit({
          type: 'tool.call.resolved',
          ts: Date.now(),
          ids,
          source: 'l2',
          call: { id: callId, name: input.tool_name, input: input.tool_input },
          result: {
            content,
            ...(input.duration_ms !== undefined ? { durationMs: input.duration_ms } : {}),
          },
        });
        return {};
      }
      case 'SessionStart': {
        const ids = buildIds(input, fallbackSessionId);
        const evt: AgentEvent = {
          type: 'session.start',
          ts: Date.now(),
          ids,
          source: 'l2',
          meta: { source: (input as { source?: string }).source ?? 'startup' },
        };
        await bus.emit(evt);
        return {};
      }
      case 'SessionEnd':
      case 'Stop': {
        const ids = buildIds(input, fallbackSessionId);
        await bus.emit({
          type: 'session.end',
          ts: Date.now(),
          ids,
          source: 'l2',
          reason: 'complete',
        });
        return {};
      }
      case 'PreCompact': {
        const ids = buildIds(input, fallbackSessionId);
        await bus.emit({
          type: 'context.compacted',
          ts: Date.now(),
          ids,
          source: 'l2',
        });
        return {};
      }
      case 'SubagentStart': {
        if (!isSubagentStart(input)) return {};
        const sessionId = input.session_id ?? fallbackSessionId();
        const childSessionId = input.child_session_id ?? createSessionId();
        const evt: AgentEvent = {
          type: 'subagent.spawn',
          ts: Date.now(),
          ids: { sessionId, turnId: createTurnId() },
          source: 'l2',
          parentSessionId: input.parent_session_id ?? sessionId,
          childSessionId,
          ...(input.agent_type ? { purpose: input.agent_type } : {}),
        };
        await bus.emit(evt);
        return {};
      }
      case 'SubagentStop': {
        if (!isSubagentStop(input)) return {};
        const sessionId = input.session_id ?? fallbackSessionId();
        const evt: AgentEvent = {
          type: 'subagent.return',
          ts: Date.now(),
          ids: { sessionId, turnId: createTurnId() },
          source: 'l2',
          childSessionId: input.child_session_id ?? sessionId,
          ...(input.result ? { summary: input.result } : {}),
        };
        await bus.emit(evt);
        return {};
      }
      default:
        return {};
    }
  };

const wrapCanUseTool =
  (bus: EventBus, original: CanUseTool | undefined, fallbackSessionId: () => string): CanUseTool =>
  async (toolName, input, options) => {
    const sessionId = fallbackSessionId();
    const turnId = createTurnId();
    const callId = options.toolUseID ?? createCallId();
    const ids: AgentIds = { sessionId, turnId, callId };
    const pendingId = createPendingId();
    await bus.emit({
      type: 'approval.requested',
      ts: Date.now(),
      ids,
      source: 'l2',
      call: { id: callId, name: toolName, input },
      pendingId,
    });

    const result: PermissionResult = original
      ? await original(toolName, input, options)
      : { behavior: 'allow' };

    await bus.emit({
      type: 'approval.resolved',
      ts: Date.now(),
      ids,
      source: 'l2',
      pendingId,
      decision: result.behavior === 'allow' ? 'approve' : 'deny',
    });
    return result;
  };

const HOOKS_TO_INSTRUMENT: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
];

export const withHarnesskit = <T extends ClaudeAgentSdkOptions>(
  busOrOptions: EventBus | WithHarnesskitOptions,
  sdkOptions: T,
): T => {
  const opts: WithHarnesskitOptions =
    'bus' in busOrOptions ? busOrOptions : { bus: busOrOptions as EventBus };
  let cachedSessionId: string | undefined;
  const fallbackSessionId: () => string =
    opts.fallbackSessionId ??
    (() => {
      if (!cachedSessionId) cachedSessionId = createSessionId();
      return cachedSessionId;
    });

  const existingHooks = sdkOptions.hooks ?? {};
  const wrappedHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...existingHooks };

  for (const eventName of HOOKS_TO_INSTRUMENT) {
    const observer: HookCallbackMatcher = {
      hooks: [makeObserverHook(opts.bus, eventName, fallbackSessionId)],
    };
    wrappedHooks[eventName] = [...(existingHooks[eventName] ?? []), observer];
  }

  return {
    ...sdkOptions,
    hooks: wrappedHooks,
    canUseTool: wrapCanUseTool(opts.bus, sdkOptions.canUseTool, fallbackSessionId),
  };
};

/**
 * @deprecated Use `withHarnesskit(bus, sdkOptions)` instead — it returns
 * instrumented options to pass to `query()`.
 */
export function attachClaudeAgentSdkAdapter(_opts: { bus: EventBus }): () => void {
  throw new Error(
    'attachClaudeAgentSdkAdapter is deprecated. Use withHarnesskit(bus, sdkOptions) instead.',
  );
}
