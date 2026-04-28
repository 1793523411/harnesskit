import type { Trace } from './recorder.js';

export interface Scorer {
  readonly id: string;
  readonly description?: string;
  score(trace: Trace): number | Promise<number>;
}

export interface ScoreResult {
  scorerId: string;
  value: number;
  details?: Record<string, unknown>;
}

export const toolCallCount = (id = 'tool-call-count'): Scorer => ({
  id,
  description: 'count of tool.call.requested events',
  score: (t) => t.events.filter((e) => e.type === 'tool.call.requested').length,
});

export const deniedRatio = (id = 'denied-ratio'): Scorer => ({
  id,
  description: 'ratio of denied calls to requested calls (0 if none requested)',
  score: (t) => {
    const requested = t.events.filter((e) => e.type === 'tool.call.requested').length;
    if (requested === 0) return 0;
    const denied = t.events.filter((e) => e.type === 'tool.call.denied').length;
    return denied / requested;
  },
});

export const totalTokens = (id = 'total-tokens'): Scorer => ({
  id,
  description: 'cumulative input + output tokens across all usage events',
  score: (t) => {
    let total = 0;
    for (const e of t.events) {
      if (e.type === 'usage') {
        total += (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
      }
    }
    return total;
  },
});

export const turnCount = (id = 'turn-count'): Scorer => ({
  id,
  description: 'count of model turns (turn.start events)',
  score: (t) => t.events.filter((e) => e.type === 'turn.start').length,
});

export const errorCount = (id = 'error-count'): Scorer => ({
  id,
  description: 'count of error events',
  score: (t) => t.events.filter((e) => e.type === 'error').length,
});

export const durationMs = (id = 'duration-ms'): Scorer => ({
  id,
  description: 'session wall-clock duration in milliseconds',
  score: (t) => {
    if (t.events.length === 0) return 0;
    const last = t.endedAt ?? t.events[t.events.length - 1]?.ts ?? t.startedAt;
    return last - t.startedAt;
  },
});

export const scoreTrace = async (
  trace: Trace,
  scorers: readonly Scorer[],
): Promise<ScoreResult[]> => {
  return Promise.all(scorers.map(async (s) => ({ scorerId: s.id, value: await s.score(trace) })));
};
