import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus.js';
import type { AgentEvent, ToolCallRequestedEvent } from './events.js';
import type { Interceptor } from './interceptor.js';

const baseIds = { sessionId: 's1', turnId: 't1' };

const toolEvent = (name = 'shell'): ToolCallRequestedEvent => ({
  type: 'tool.call.requested',
  ts: 1,
  ids: baseIds,
  source: 'l1',
  call: { id: 'c1', name, input: { cmd: 'rm -rf /' } },
});

const sessionStart = (): AgentEvent => ({
  type: 'session.start',
  ts: 1,
  ids: baseIds,
  source: 'l1',
});

describe('EventBus', () => {
  it('dispatches events through interceptors in order', async () => {
    const seen: string[] = [];
    const bus = new EventBus();
    bus.use({ on: () => void seen.push('a') });
    bus.use({ on: () => void seen.push('b') });

    await bus.emit(sessionStart());
    expect(seen).toEqual(['a', 'b']);
  });

  it('supports deny() on gateable events', async () => {
    const bus = new EventBus();
    bus.use({
      on: (_, ctx) => ctx.deny('dangerous', 'no-rm-rf'),
    });

    const result = await bus.emit(toolEvent());
    expect(result.denied).toEqual({ reason: 'dangerous', policyId: 'no-rm-rf' });
  });

  it('first deny wins; later interceptors still run but cannot overwrite', async () => {
    const bus = new EventBus();
    bus.use({ on: (_, ctx) => ctx.deny('first') });
    bus.use({ on: (_, ctx) => ctx.deny('second') });

    const result = await bus.emit(toolEvent());
    expect(result.denied?.reason).toBe('first');
  });

  it('warns when deny() is called on non-gateable events', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new EventBus();
    bus.use({ on: (_, ctx) => ctx.deny('nope') });

    const result = await bus.emit(sessionStart());
    expect(result.denied).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('runs init() lazily on first emit and dispose() on teardown', async () => {
    const lifecycle: string[] = [];
    const interceptor: Interceptor = {
      init: () => void lifecycle.push('init'),
      on: () => void lifecycle.push('on'),
      dispose: () => void lifecycle.push('dispose'),
    };
    const bus = new EventBus();
    bus.use(interceptor);

    await bus.emit(sessionStart());
    await bus.emit(sessionStart());
    await bus.dispose();

    expect(lifecycle).toEqual(['init', 'on', 'on', 'dispose']);
  });

  it('isolates interceptor errors by default and surfaces via onUnhandledError', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({
      onUnhandledError: (err) => errors.push(err),
    });
    bus.use({
      on: () => {
        throw new Error('boom');
      },
    });
    bus.use({ on: () => {} }); // should still run

    await bus.emit(sessionStart());
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('throws when failFast is true', async () => {
    const bus = new EventBus({ failFast: true });
    bus.use({
      on: () => {
        throw new Error('fail-fast');
      },
    });
    await expect(bus.emit(sessionStart())).rejects.toThrow('fail-fast');
  });

  it('rejects use() after dispose', async () => {
    const bus = new EventBus();
    await bus.dispose();
    expect(() => bus.use({ on: () => {} })).toThrow('disposed');
  });
});
