import {
  type AgentEvent,
  EventBus,
  type ToolCallRequestedEvent,
  type UsageEvent,
} from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import {
  TraceRecorder,
  deniedRatio,
  errorCount,
  replayTrace,
  scoreTrace,
  toolCallCount,
  totalTokens,
  traceFromJson,
  traceToJson,
  turnCount,
} from './index.js';

const ids = (sessionId = 's1', turnId = 't1') => ({ sessionId, turnId });

const sessionStart = (sid = 's1', ts = 1): AgentEvent => ({
  type: 'session.start',
  ts,
  ids: ids(sid),
  source: 'l1',
});

const sessionEnd = (sid = 's1', ts = 100): AgentEvent => ({
  type: 'session.end',
  ts,
  ids: ids(sid),
  source: 'l1',
  reason: 'complete',
});

const toolEvt = (name: string, callId = 'c1', sid = 's1'): ToolCallRequestedEvent => ({
  type: 'tool.call.requested',
  ts: 5,
  ids: { ...ids(sid), callId },
  source: 'l1',
  call: { id: callId, name, input: {} },
});

const usageEvt = (input: number, output: number, sid = 's1'): UsageEvent => ({
  type: 'usage',
  ts: 10,
  ids: ids(sid),
  source: 'l1',
  usage: { inputTokens: input, outputTokens: output },
});

const denyEvt = (callId = 'c1', sid = 's1'): AgentEvent => ({
  type: 'tool.call.denied',
  ts: 6,
  ids: { ...ids(sid), callId },
  source: 'l1',
  call: { id: callId, name: 'shell', input: {} },
  reason: 'denied',
});

describe('TraceRecorder', () => {
  it('aggregates events per session', async () => {
    const recorder = new TraceRecorder();
    const bus = new EventBus().use(recorder);
    await bus.emit(sessionStart('A'));
    await bus.emit(toolEvt('shell', 'c1', 'A'));
    await bus.emit(sessionStart('B'));
    await bus.emit(usageEvt(10, 20, 'B'));
    await bus.emit(sessionEnd('A'));

    expect(recorder.sessionCount).toBe(2);
    const ta = recorder.getTrace('A');
    expect(ta?.events).toHaveLength(3);
    expect(ta?.endedAt).toBe(100);
    const tb = recorder.getTrace('B');
    expect(tb?.events).toHaveLength(2);
    expect(tb?.endedAt).toBeUndefined();
  });

  it('returns frozen copies (mutation does not leak)', async () => {
    const recorder = new TraceRecorder();
    const bus = new EventBus().use(recorder);
    await bus.emit(sessionStart('A'));
    const t1 = recorder.getTrace('A');
    expect(t1?.events).toHaveLength(1);
    await bus.emit(sessionStart('A'));
    expect(t1?.events).toHaveLength(1); // snapshot is independent
    const t2 = recorder.getTrace('A');
    expect(t2?.events).toHaveLength(2);
  });

  it('clear removes data', async () => {
    const recorder = new TraceRecorder();
    const bus = new EventBus().use(recorder);
    await bus.emit(sessionStart('A'));
    await bus.emit(sessionStart('B'));
    recorder.clear('A');
    expect(recorder.getTrace('A')).toBeUndefined();
    expect(recorder.getTrace('B')).toBeDefined();
    recorder.clear();
    expect(recorder.sessionCount).toBe(0);
  });
});

describe('builtin scorers', () => {
  const trace = {
    sessionId: 's1',
    startedAt: 0,
    endedAt: 100,
    events: [
      sessionStart(),
      { ...toolEvt('shell', 'c1'), type: 'tool.call.requested' as const },
      denyEvt('c1'),
      { ...toolEvt('read', 'c2'), type: 'tool.call.requested' as const },
      usageEvt(10, 20),
      usageEvt(5, 15),
      {
        type: 'turn.start',
        ts: 1,
        ids: ids(),
        source: 'l1',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        request: { messages: [] },
      } as AgentEvent,
      {
        type: 'error',
        ts: 1,
        ids: ids(),
        source: 'l1',
        message: 'oops',
        stage: 'unknown',
      } as AgentEvent,
      sessionEnd(),
    ],
  };

  it('counts and ratios', async () => {
    const results = await scoreTrace(trace, [
      toolCallCount(),
      deniedRatio(),
      totalTokens(),
      turnCount(),
      errorCount(),
    ]);
    const byId = Object.fromEntries(results.map((r) => [r.scorerId, r.value]));
    expect(byId['tool-call-count']).toBe(2);
    expect(byId['denied-ratio']).toBe(0.5);
    expect(byId['total-tokens']).toBe(50);
    expect(byId['turn-count']).toBe(1);
    expect(byId['error-count']).toBe(1);
  });

  it('deniedRatio returns 0 when no calls were requested', async () => {
    const empty = { sessionId: 's', startedAt: 0, events: [] };
    const [r] = await scoreTrace(empty, [deniedRatio()]);
    expect(r?.value).toBe(0);
  });
});

describe('replayTrace', () => {
  it('re-emits events into a new bus and surfaces denials', async () => {
    const trace = {
      sessionId: 's1',
      startedAt: 0,
      events: [toolEvt('shell', 'c1'), toolEvt('read_file', 'c2')],
    };
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('blocked', 'p');
        }
      },
    });
    const result = await replayTrace(trace, bus);
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0]?.reason).toBe('blocked');
    expect(result.denials[0]?.policyId).toBe('p');
  });
});

describe('JSON round-trip', () => {
  it('traceToJson then traceFromJson preserves shape', () => {
    const trace = {
      sessionId: 's1',
      startedAt: 0,
      endedAt: 5,
      events: [sessionStart(), sessionEnd()],
    };
    const json = traceToJson(trace);
    const back = traceFromJson(json);
    expect(back.sessionId).toBe('s1');
    expect(back.events).toHaveLength(2);
    expect(back.endedAt).toBe(5);
  });

  it('throws on malformed JSON', () => {
    expect(() => traceFromJson('null')).toThrow('expected JSON object');
    expect(() => traceFromJson('{"sessionId":"x"}')).toThrow('missing events array');
  });
});
