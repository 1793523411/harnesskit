import type { AgentEvent, Interceptor } from '@harnesskit/core';

export interface Trace {
  readonly sessionId: string;
  readonly events: readonly AgentEvent[];
  readonly startedAt: number;
  readonly endedAt?: number;
}

interface MutableTrace {
  sessionId: string;
  events: AgentEvent[];
  startedAt: number;
  endedAt?: number;
}

const freeze = (m: MutableTrace): Trace => ({
  sessionId: m.sessionId,
  events: m.events.slice(),
  startedAt: m.startedAt,
  ...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {}),
});

export class TraceRecorder implements Interceptor {
  readonly name = 'trace-recorder';
  private readonly traces = new Map<string, MutableTrace>();

  on(event: AgentEvent): void {
    const sessionId = event.ids.sessionId;
    let m = this.traces.get(sessionId);
    if (!m) {
      m = { sessionId, events: [], startedAt: event.ts };
      this.traces.set(sessionId, m);
    }
    m.events.push(event);
    if (event.type === 'session.end') m.endedAt = event.ts;
  }

  getTrace(sessionId: string): Trace | undefined {
    const m = this.traces.get(sessionId);
    return m ? freeze(m) : undefined;
  }

  allTraces(): Trace[] {
    return [...this.traces.values()].map(freeze);
  }

  clear(sessionId?: string): void {
    if (sessionId) this.traces.delete(sessionId);
    else this.traces.clear();
  }

  get sessionCount(): number {
    return this.traces.size;
  }
}
