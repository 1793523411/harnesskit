import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { attachOpenAIAgentsAdapter } from './index.js';
import type { RunHooksLike, RunHooksListener } from './types.js';

class MockEmitter implements RunHooksLike {
  private listeners = new Map<string, Set<RunHooksListener>>();
  on(event: string, l: RunHooksListener): this {
    let s = this.listeners.get(event);
    if (!s) {
      s = new Set();
      this.listeners.set(event, s);
    }
    s.add(l);
    return this;
  }
  off(event: string, l: RunHooksListener): this {
    this.listeners.get(event)?.delete(l);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const collect = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({
    on: (e) => {
      events.push(e);
    },
  });
  return events;
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('OpenAI Agents L2 adapter', () => {
  it('emits session.start on first agent_start, then tool.call.requested/resolved', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hooks = new MockEmitter();
    const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: hooks });

    const ctx = { runId: 'run_1' };
    const agent = { name: 'main' };
    const tool = { name: 'shell' };
    const toolCall = { id: 'tc_1', name: 'shell', arguments: { cmd: 'ls' } };

    hooks.emit('agent_start', ctx, agent);
    hooks.emit('agent_tool_start', ctx, agent, tool, { toolCall });
    hooks.emit('agent_tool_end', ctx, agent, tool, 'file1\nfile2', { toolCall });
    await flush();
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['session.start', 'tool.call.requested', 'tool.call.resolved']);

    const start = events[0];
    if (start?.type !== 'session.start') throw new Error('expected session.start');
    expect(start.meta?.agent).toBe('main');

    const requested = events[1];
    if (requested?.type !== 'tool.call.requested') throw new Error('expected requested');
    expect(requested.call.id).toBe('tc_1');
    expect(requested.call.name).toBe('shell');
    expect(requested.call.input).toEqual({ cmd: 'ls' });

    const resolved = events[2];
    if (resolved?.type !== 'tool.call.resolved') throw new Error('expected resolved');
    expect(resolved.result.content).toBe('file1\nfile2');
  });

  it('emits subagent.spawn on agent_handoff', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hooks = new MockEmitter();
    const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: hooks });

    hooks.emit('agent_start', {}, { name: 'router' });
    hooks.emit('agent_handoff', {}, { name: 'router' }, { name: 'researcher' });
    await flush();
    dispose();

    const spawn = events.find((e) => e.type === 'subagent.spawn');
    expect(spawn).toBeDefined();
    if (spawn?.type !== 'subagent.spawn') throw new Error('wrong');
    expect(spawn.purpose).toBe('researcher');
  });

  it('emits session.start only once even after multiple agent_start (handoffs)', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hooks = new MockEmitter();
    const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: hooks });

    hooks.emit('agent_start', {}, { name: 'a' });
    hooks.emit('agent_start', {}, { name: 'b' });
    hooks.emit('agent_start', {}, { name: 'c' });
    await flush();
    dispose();

    const starts = events.filter((e) => e.type === 'session.start');
    expect(starts).toHaveLength(1);
  });

  it('dispose() unsubscribes all listeners', () => {
    const bus = new EventBus();
    const hooks = new MockEmitter();
    const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: hooks });
    expect(hooks.listenerCount('agent_start')).toBe(1);
    expect(hooks.listenerCount('agent_tool_start')).toBe(1);
    dispose();
    expect(hooks.listenerCount('agent_start')).toBe(0);
    expect(hooks.listenerCount('agent_tool_start')).toBe(0);
  });

  it('handles missing toolCall details gracefully', async () => {
    const bus = new EventBus();
    const events = collect(bus);
    const hooks = new MockEmitter();
    const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: hooks });

    hooks.emit('agent_start', {}, { name: 'a' });
    hooks.emit('agent_tool_start', {}, { name: 'a' }, { name: 'shell' }, undefined);
    await flush();
    dispose();

    const requested = events.find((e) => e.type === 'tool.call.requested');
    if (requested?.type !== 'tool.call.requested') throw new Error('wrong');
    expect(requested.call.name).toBe('shell');
    expect(requested.call.input).toEqual({});
  });
});
