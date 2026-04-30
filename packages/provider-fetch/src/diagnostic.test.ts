import { EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { createDiagnostic } from './diagnostic.js';
import { installFetchInterceptor } from './intercept.js';

const mockJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('createDiagnostic', () => {
  it('reports fetchPatched=false on a vanilla target', () => {
    const bus = new EventBus();
    const target = { fetch: globalThis.fetch };
    const diag = createDiagnostic({ bus, target });
    const r = diag.report();
    expect(r.fetchPatched).toBe(false);
    expect(r.totalEvents).toBe(0);
    expect(r.warnings.some((w) => w.includes('did not have'))).toBe(false);
    // The "did not have" wording isn't required exactly — just the gist:
    expect(r.warnings.some((w) => /not call|patch marker/i.test(w))).toBe(true);
  });

  it('reports fetchPatched=true after installFetchInterceptor', () => {
    const bus = new EventBus();
    const target = { fetch: async () => mockJson({}) } as unknown as { fetch: typeof fetch };
    const diag = createDiagnostic({ bus, target });
    const dispose = installFetchInterceptor({ bus, target });
    expect(diag.report().fetchPatched).toBe(true);
    dispose();
    // After dispose, the original fetch is restored — patch marker gone.
    expect(diag.report().fetchPatched).toBe(false);
  });

  it('counts events seen on the bus and breaks them down by type', async () => {
    const bus = new EventBus();
    const target = {
      fetch: async () =>
        mockJson({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
    };
    const diag = createDiagnostic({ bus });
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    dispose();

    const r = diag.report();
    expect(r.turnsObserved).toBe(1);
    expect(r.eventsByType['turn.start']).toBe(1);
    expect(r.eventsByType['turn.end']).toBe(1);
    expect(r.eventsByType['usage']).toBe(1);
    expect(r.totalEvents).toBeGreaterThanOrEqual(3);
  });

  it('captures error events with stage + truncated message', async () => {
    const bus = new EventBus();
    const target = {
      fetch: async () => {
        throw new Error('synthetic network failure ' + 'x'.repeat(200));
      },
    } as unknown as { fetch: typeof fetch };
    const diag = createDiagnostic({ bus });
    const dispose = installFetchInterceptor({ bus, target });
    await target
      .fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      .catch(() => undefined);
    dispose();

    const r = diag.report();
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.stage).toBe('turn.start');
    expect(r.errors[0]?.message.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(r.warnings.some((w) => w.includes('error event'))).toBe(true);
  });

  it('emits a "patched but no events" warning after install but before any traffic', () => {
    const bus = new EventBus();
    const target = { fetch: async () => mockJson({}) } as unknown as { fetch: typeof fetch };
    const diag = createDiagnostic({ bus, target });
    const dispose = installFetchInterceptor({ bus, target });
    const r = diag.report();
    dispose();
    expect(r.fetchPatched).toBe(true);
    expect(r.totalEvents).toBe(0);
    expect(r.warnings.some((w) => w.toLowerCase().includes('no events'))).toBe(true);
  });

  it('format() produces a human-readable report', async () => {
    const bus = new EventBus();
    const target = {
      fetch: async () =>
        mockJson({
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
        }),
    };
    const diag = createDiagnostic({ bus });
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    dispose();
    const out = diag.format();
    expect(out).toContain('harnesskit diagnostic');
    expect(out).toContain('fetch patched:');
    expect(out).toContain('turns observed:');
  });

  it('dispose() stops counting further events', async () => {
    const bus = new EventBus();
    const target = {
      fetch: async () =>
        mockJson({
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
        }),
    };
    const diag = createDiagnostic({ bus });
    const dispose = installFetchInterceptor({ bus, target });
    diag.dispose();
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    dispose();
    expect(diag.report().totalEvents).toBe(0);
  });
});
