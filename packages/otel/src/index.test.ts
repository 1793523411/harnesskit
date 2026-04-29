import { EventBus } from '@harnesskit/core';
import { describe, expect, it, vi } from 'vitest';
import { type OtelTracer, SPAN_STATUS_ERROR, SPAN_STATUS_OK, otelExporter } from './index.js';

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  exception?: { message: string };
  endTime?: number;
}

const makeMockTracer = (): { tracer: OtelTracer; spans: RecordedSpan[] } => {
  const spans: RecordedSpan[] = [];
  const tracer: OtelTracer = {
    startSpan(name, options) {
      const span: RecordedSpan = {
        name,
        attributes: { ...(options?.attributes ?? {}) },
      };
      spans.push(span);
      return {
        setAttribute(k, v) {
          span.attributes[k] = v;
        },
        setStatus(s) {
          span.status = s;
        },
        recordException(e) {
          span.exception = e;
        },
        end(t) {
          span.endTime = t;
        },
      };
    },
  };
  return { tracer, spans };
};

const ids = { sessionId: 'sess_1', turnId: 'turn_1' };

describe('otelExporter', () => {
  it('starts a session span on session.start and ends it on session.end', async () => {
    const { tracer, spans } = makeMockTracer();
    const bus = new EventBus();
    bus.use(otelExporter({ tracer }));

    await bus.emit({ type: 'session.start', ts: 1, ids, source: 'l1' });
    await bus.emit({ type: 'session.end', ts: 100, ids, source: 'l1', reason: 'complete' });

    const session = spans.find((s) => s.name === 'harnesskit.session');
    expect(session).toBeDefined();
    expect(session?.attributes['session.id']).toBe('sess_1');
    expect(session?.endTime).toBe(100);
    expect(session?.status?.code).toBe(SPAN_STATUS_OK);
  });

  it('starts a turn span with provider/model/usage attributes', async () => {
    const { tracer, spans } = makeMockTracer();
    const bus = new EventBus();
    bus.use(otelExporter({ tracer }));

    await bus.emit({
      type: 'turn.start',
      ts: 10,
      ids,
      source: 'l1',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      request: { messages: [{ role: 'user', content: 'hi' }] },
    });
    await bus.emit({
      type: 'usage',
      ts: 20,
      ids,
      source: 'l1',
      usage: { inputTokens: 5, outputTokens: 8 },
    });
    await bus.emit({
      type: 'turn.end',
      ts: 30,
      ids,
      source: 'l1',
      durationMs: 20,
      response: { content: [], stopReason: 'end_turn' },
    });

    const turn = spans.find((s) => s.name === 'harnesskit.turn');
    expect(turn).toBeDefined();
    expect(turn?.attributes['gen_ai.system']).toBe('anthropic');
    expect(turn?.attributes['gen_ai.request.model']).toBe('claude-opus-4-7');
    expect(turn?.attributes['gen_ai.usage.input_tokens']).toBe(5);
    expect(turn?.attributes['gen_ai.usage.output_tokens']).toBe(8);
    expect(turn?.attributes['gen_ai.response.finish_reason']).toBe('end_turn');
    expect(turn?.endTime).toBe(30);
  });

  it('starts and ends a tool span on requested → resolved', async () => {
    const { tracer, spans } = makeMockTracer();
    const bus = new EventBus();
    bus.use(otelExporter({ tracer }));

    const callIds = { ...ids, callId: 'c1' };
    await bus.emit({
      type: 'tool.call.requested',
      ts: 40,
      ids: callIds,
      source: 'l1',
      call: { id: 'c1', name: 'shell', input: { cmd: 'ls' } },
    });
    await bus.emit({
      type: 'tool.call.resolved',
      ts: 50,
      ids: callIds,
      source: 'l1',
      call: { id: 'c1', name: 'shell', input: { cmd: 'ls' } },
      result: { content: 'file1\nfile2', durationMs: 10 },
    });

    const tool = spans.find((s) => s.name === 'harnesskit.tool.shell');
    expect(tool).toBeDefined();
    expect(tool?.attributes['tool.name']).toBe('shell');
    expect(tool?.attributes['tool.output']).toBe('file1\nfile2');
    expect(tool?.attributes.duration_ms).toBe(10);
    expect(tool?.status?.code).toBe(SPAN_STATUS_OK);
  });

  it('marks a denied tool span with ERROR status and reason', async () => {
    const { tracer, spans } = makeMockTracer();
    const bus = new EventBus();
    bus.use(otelExporter({ tracer }));

    const callIds = { ...ids, callId: 'c2' };
    await bus.emit({
      type: 'tool.call.requested',
      ts: 60,
      ids: callIds,
      source: 'l1',
      call: { id: 'c2', name: 'shell', input: {} },
    });
    await bus.emit({
      type: 'tool.call.denied',
      ts: 70,
      ids: callIds,
      source: 'l1',
      call: { id: 'c2', name: 'shell', input: {} },
      reason: 'shell disabled',
      policyId: 'no-shell',
    });

    const tool = spans.find((s) => s.name === 'harnesskit.tool.shell');
    expect(tool?.status?.code).toBe(SPAN_STATUS_ERROR);
    expect(tool?.attributes['tool.denied']).toBe(true);
    expect(tool?.attributes['tool.deny_reason']).toBe('shell disabled');
    expect(tool?.attributes['tool.deny_policy']).toBe('no-shell');
  });

  it('supports custom prefix and redaction', async () => {
    const { tracer, spans } = makeMockTracer();
    const bus = new EventBus();
    const redact = vi.fn((k: string, v: unknown) => (k === 'tool.input' ? '[redacted]' : v));
    bus.use(
      otelExporter({
        tracer,
        prefix: 'myapp.',
        redactAttributes: redact as never,
      }),
    );

    await bus.emit({
      type: 'tool.call.requested',
      ts: 1,
      ids: { ...ids, callId: 'c' },
      source: 'l1',
      call: { id: 'c', name: 'x', input: { secret: 'shh' } },
    });

    const tool = spans.find((s) => s.name === 'myapp.tool.x');
    expect(tool).toBeDefined();
    expect(tool?.attributes['tool.input']).toBe('[redacted]');
  });
});
