import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { withHarnesskit } from './index.js';
import type {
  ClaudeAgentSdkOptions,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from './types.js';

const collect = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({
    on: (e) => {
      events.push(e);
    },
  });
  return events;
};

const fireHooks = async (
  options: ClaudeAgentSdkOptions,
  event: HookEvent,
  input: HookInput,
  toolUseID?: string,
): Promise<HookJSONOutput[]> => {
  const matchers = options.hooks?.[event] ?? [];
  const out: HookJSONOutput[] = [];
  for (const m of matchers) {
    for (const h of m.hooks) {
      out.push(await h(input, toolUseID, { signal: new AbortController().signal }));
    }
  }
  return out;
};

describe('withHarnesskit', () => {
  it('emits tool.call.requested on PreToolUse and returns deny when bus denies', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });
    const events = collect(bus);

    const wrapped = withHarnesskit(bus, {} as ClaudeAgentSdkOptions);

    const outputs = await fireHooks(
      wrapped,
      'PreToolUse',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'shell',
        tool_input: { cmd: 'ls' },
        tool_use_id: 'tu_1',
        session_id: 'sess_test',
      },
      'tu_1',
    );

    const out = outputs[0];
    expect(out).toBeDefined();
    if (!out || 'async' in out) throw new Error('expected sync output');
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.call.requested');
    expect(types).toContain('tool.call.denied');
  });

  it('lets non-denied tools through with empty output', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {} as ClaudeAgentSdkOptions);

    const outputs = await fireHooks(wrapped, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'read_file',
      tool_input: { path: '/tmp/x' },
      tool_use_id: 'tu_2',
    });

    expect(outputs[0]).toEqual({});
    const types = events.map((e) => e.type);
    expect(types).toEqual(['tool.call.requested']);
  });

  it('preserves user hooks (runs them in addition to ours)', async () => {
    const bus = new EventBus();
    let userHookCalled = false;
    const userHook: HookCallback = async () => {
      userHookCalled = true;
      return {};
    };
    const wrapped = withHarnesskit(bus, {
      hooks: { PreToolUse: [{ hooks: [userHook] }] },
    } as ClaudeAgentSdkOptions);

    expect(wrapped.hooks?.PreToolUse?.length).toBe(2);

    await fireHooks(wrapped, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'read_file',
      tool_input: {},
      tool_use_id: 'x',
    });
    expect(userHookCalled).toBe(true);
  });

  it('emits tool.call.resolved on PostToolUse', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {} as ClaudeAgentSdkOptions);

    await fireHooks(wrapped, 'PostToolUse', {
      hook_event_name: 'PostToolUse',
      tool_name: 'read_file',
      tool_input: { path: '/x' },
      tool_response: 'file contents',
      tool_use_id: 'tu_3',
      duration_ms: 12,
    });

    const resolved = events.find((e) => e.type === 'tool.call.resolved');
    expect(resolved).toBeDefined();
    if (resolved?.type !== 'tool.call.resolved') throw new Error('wrong type');
    expect(resolved.result.content).toBe('file contents');
    expect(resolved.result.durationMs).toBe(12);
  });

  it('emits subagent.spawn / subagent.return', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {} as ClaudeAgentSdkOptions);

    await fireHooks(wrapped, 'SubagentStart', {
      hook_event_name: 'SubagentStart',
      session_id: 'parent',
      child_session_id: 'child',
      agent_type: 'researcher',
    } as HookInput);
    await fireHooks(wrapped, 'SubagentStop', {
      hook_event_name: 'SubagentStop',
      session_id: 'parent',
      child_session_id: 'child',
      result: 'done',
    } as HookInput);

    const spawn = events.find((e) => e.type === 'subagent.spawn');
    const ret = events.find((e) => e.type === 'subagent.return');
    expect(spawn).toBeDefined();
    expect(ret).toBeDefined();
    if (spawn?.type !== 'subagent.spawn') throw new Error('wrong');
    expect(spawn.childSessionId).toBe('child');
    expect(spawn.purpose).toBe('researcher');
    if (ret?.type !== 'subagent.return') throw new Error('wrong');
    expect(ret.summary).toBe('done');
  });

  it('emits session.start and session.end', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {} as ClaudeAgentSdkOptions);

    await fireHooks(wrapped, 'SessionStart', {
      hook_event_name: 'SessionStart',
      session_id: 'sess1',
      source: 'startup',
    } as HookInput);
    await fireHooks(wrapped, 'SessionEnd', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess1',
    } as HookInput);

    expect(events.map((e) => e.type)).toEqual(['session.start', 'session.end']);
  });

  it('wraps canUseTool with approval.requested + approval.resolved', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    let userCalled = false;
    const wrapped = withHarnesskit(bus, {
      canUseTool: async () => {
        userCalled = true;
        return { behavior: 'allow' };
      },
    } as ClaudeAgentSdkOptions);

    const result = await wrapped.canUseTool?.(
      'shell',
      { cmd: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tu_4' },
    );

    expect(userCalled).toBe(true);
    expect(result?.behavior).toBe('allow');
    const types = events.map((e) => e.type);
    expect(types).toEqual(['approval.requested', 'approval.resolved']);
    const resolved = events[1];
    if (resolved?.type !== 'approval.resolved') throw new Error('wrong');
    expect(resolved.decision).toBe('approve');
  });

  it('canUseTool emits deny resolution when user denies', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {
      canUseTool: async () => ({ behavior: 'deny', message: 'blocked' }),
    } as ClaudeAgentSdkOptions);

    const result = await wrapped.canUseTool?.(
      'shell',
      {},
      { signal: new AbortController().signal, toolUseID: 'tu_5' },
    );
    expect(result?.behavior).toBe('deny');
    const resolved = events.find((e) => e.type === 'approval.resolved');
    if (resolved?.type !== 'approval.resolved') throw new Error('wrong');
    expect(resolved.decision).toBe('deny');
  });
});
