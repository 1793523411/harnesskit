import type { EventBus } from '@harnesskit/core';
import type { Trace } from './recorder.js';

/**
 * Re-emit a captured Trace through a different EventBus.
 * Useful for testing: capture a trace once, then replay against a new
 * policy stack to see what would have been allowed/denied.
 *
 * Returns the original trace plus any deny decisions surfaced by the bus
 * during replay (events whose dispatch was denied by an interceptor).
 */
export interface ReplayResult {
  trace: Trace;
  denials: { event: Trace['events'][number]; reason: string; policyId?: string }[];
}

export const replayTrace = async (trace: Trace, bus: EventBus): Promise<ReplayResult> => {
  const denials: ReplayResult['denials'] = [];
  for (const event of trace.events) {
    const result = await bus.emit(event);
    if (result.denied) {
      denials.push({
        event,
        reason: result.denied.reason,
        ...(result.denied.policyId ? { policyId: result.denied.policyId } : {}),
      });
    }
  }
  return { trace, denials };
};

export const traceToJson = (trace: Trace): string => JSON.stringify(trace);

export const traceFromJson = (json: string): Trace => {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('traceFromJson: expected JSON object');
  }
  if (typeof parsed.sessionId !== 'string') {
    throw new Error('traceFromJson: missing sessionId');
  }
  if (!Array.isArray(parsed.events)) {
    throw new Error('traceFromJson: missing events array');
  }
  return parsed as Trace;
};
