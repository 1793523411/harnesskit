import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { harnesskitCallbacks } from './index.js';

const collect = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  return events;
};

describe('harnesskitCallbacks (LangGraph adapter)', () => {
  it('maps LLM start/end/usage to turn.start/turn.end/usage', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const cb = harnesskitCallbacks({ bus });

    await cb.handleLLMStart?.({ lc_kwargs: { model: 'gpt-4o' } }, ['hello'], 'run-1');
    await cb.handleLLMEnd?.(
      { llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 20 } } },
      'run-1',
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage']);

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('wrong');
    expect(turnStart.model).toBe('gpt-4o');

    const usage = events[2];
    if (usage?.type !== 'usage') throw new Error('wrong');
    expect(usage.usage.inputTokens).toBe(10);
    expect(usage.usage.outputTokens).toBe(20);
  });

  it('maps tool start/end to tool.call.requested/resolved', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const cb = harnesskitCallbacks({ bus });

    await cb.handleToolStart?.({ name: 'shell' }, '{"cmd":"ls"}', 'tool-run-1', 'parent-run');
    await cb.handleToolEnd?.('file1\nfile2', 'tool-run-1');

    const requested = events.find((e) => e.type === 'tool.call.requested');
    const resolved = events.find((e) => e.type === 'tool.call.resolved');
    if (requested?.type !== 'tool.call.requested') throw new Error('wrong');
    if (resolved?.type !== 'tool.call.resolved') throw new Error('wrong');
    expect(requested.call.name).toBe('shell');
    expect(requested.call.input).toEqual({ cmd: 'ls' });
    expect(resolved.result.content).toBe('file1\nfile2');
    expect(requested.ids.callId).toBe(resolved.ids.callId);
    expect(requested.ids.turnId).toBe(resolved.ids.turnId);
  });

  it('handleToolError marks tool.call.resolved as isError', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const cb = harnesskitCallbacks({ bus });

    await cb.handleToolStart?.({ name: 'shell' }, 'cmd', 'r1');
    await cb.handleToolError?.(new Error('boom'), 'r1');

    const resolved = events.find((e) => e.type === 'tool.call.resolved');
    if (resolved?.type !== 'tool.call.resolved') throw new Error('wrong');
    expect(resolved.result.isError).toBe(true);
    expect(resolved.result.content).toBe('boom');
  });

  it('handleLLMError emits a typed error event', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const cb = harnesskitCallbacks({ bus });

    await cb.handleLLMStart?.({ lc_kwargs: { model: 'm' } }, [''], 'r1');
    await cb.handleLLMError?.(new Error('rate limit'), 'r1');

    const err = events.find((e) => e.type === 'error');
    if (err?.type !== 'error') throw new Error('wrong');
    expect(err.message).toBe('rate limit');
  });

  it('reuses parent turn ids when provided', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const cb = harnesskitCallbacks({ bus });

    await cb.handleLLMStart?.({ lc_kwargs: { model: 'm' } }, [], 'parent-1');
    await cb.handleToolStart?.({ name: 't' }, '', 'tool-1', 'parent-1');

    const turn = events.find((e) => e.type === 'turn.start');
    const tool = events.find((e) => e.type === 'tool.call.requested');
    expect(turn?.ids.turnId).toBe(tool?.ids.turnId);
  });
});
