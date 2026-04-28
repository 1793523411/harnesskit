import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { withHarnesskit } from './index.js';
import type { StepResultLike, ToolLike } from './types.js';

const collect = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({
    on: (e) => {
      events.push(e);
    },
  });
  return events;
};

const makeTool = (overrides: Partial<ToolLike> = {}): ToolLike => ({
  description: 'test',
  inputSchema: {},
  execute: async (input) => `executed with ${JSON.stringify(input)}`,
  ...overrides,
});

describe('Vercel AI L2 adapter', () => {
  it('wraps tool.execute to emit tool.call.requested before running', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {
      tools: { shell: makeTool() },
    });

    const result = await wrapped.tools?.shell.execute?.(
      { cmd: 'ls' },
      { toolCallId: 'tc_1', toolName: 'shell' },
    );
    expect(result).toBe('executed with {"cmd":"ls"}');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['tool.call.requested']);
    const requested = events[0];
    if (requested?.type !== 'tool.call.requested') throw new Error('wrong');
    expect(requested.call.id).toBe('tc_1');
    expect(requested.call.name).toBe('shell');
  });

  it('blocks tool execution and throws when bus denies', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });
    const events = collect(bus);

    let executed = false;
    const wrapped = withHarnesskit(bus, {
      tools: {
        shell: makeTool({
          execute: async () => {
            executed = true;
            return 'ran';
          },
        }),
      },
    });

    await expect(
      wrapped.tools?.shell.execute?.({ cmd: 'rm' }, { toolCallId: 'tc_x', toolName: 'shell' }),
    ).rejects.toThrow(/shell disabled/);

    expect(executed).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toEqual(['tool.call.requested', 'tool.call.denied']);
    const denied = events[1];
    if (denied?.type !== 'tool.call.denied') throw new Error('wrong');
    expect(denied.reason).toBe('shell disabled');
    expect(denied.policyId).toBe('no-shell');
  });

  it('onStepFinish emits session.start, turn.start, turn.end, usage, tool.call.resolved', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    let userStepCalls = 0;
    const wrapped = withHarnesskit(bus, {
      onStepFinish: async () => {
        userStepCalls++;
      },
    });

    const step: StepResultLike = {
      stepNumber: 0,
      model: { provider: 'openai.chat', modelId: 'gpt-4o' },
      text: 'hi',
      toolCalls: [{ toolCallId: 'tc_y', toolName: 'shell', input: { cmd: 'ls' } }],
      toolResults: [{ toolCallId: 'tc_y', toolName: 'shell', output: 'file1\nfile2' }],
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: 'tool-calls',
    };

    await wrapped.onStepFinish?.(step);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session.start',
      'turn.start',
      'turn.end',
      'usage',
      'tool.call.resolved',
    ]);

    const turnStart = events[1];
    if (turnStart?.type !== 'turn.start') throw new Error('wrong');
    expect(turnStart.provider).toBe('openai');
    expect(turnStart.model).toBe('gpt-4o');

    const usage = events[3];
    if (usage?.type !== 'usage') throw new Error('wrong');
    expect(usage.usage.inputTokens).toBe(10);
    expect(usage.usage.outputTokens).toBe(5);

    const resolved = events[4];
    if (resolved?.type !== 'tool.call.resolved') throw new Error('wrong');
    expect(resolved.call.id).toBe('tc_y');
    expect(resolved.result.content).toBe('file1\nfile2');

    expect(userStepCalls).toBe(1);
  });

  it('emits session.start only once across multiple steps', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const wrapped = withHarnesskit(bus, {});
    await wrapped.onStepFinish?.({ model: { provider: 'anthropic', modelId: 'claude' } });
    await wrapped.onStepFinish?.({ model: { provider: 'anthropic', modelId: 'claude' } });
    expect(events.filter((e) => e.type === 'session.start')).toHaveLength(1);
  });

  it('onFinish emits session.end and forwards to user callback', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    let userFinishCalled = false;
    const wrapped = withHarnesskit(bus, {
      onFinish: async () => {
        userFinishCalled = true;
      },
    });
    await wrapped.onFinish?.({ totalUsage: { inputTokens: 100 } });
    expect(events.find((e) => e.type === 'session.end')).toBeDefined();
    expect(userFinishCalled).toBe(true);
  });

  it('passes through tools with no execute function', () => {
    const bus = new EventBus();
    const wrapped = withHarnesskit(bus, {
      tools: {
        clientOnly: { description: 'client-rendered, no execute' },
      },
    });
    expect(wrapped.tools?.clientOnly.execute).toBeUndefined();
  });
});
