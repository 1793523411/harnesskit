import type { Interceptor } from '@harnesskit/core';

/**
 * Minimal subset of `@opentelemetry/api` we touch. Users pass an actual OTel
 * Tracer (from `trace.getTracer('your-app')`) — the structural type below is
 * compatible with it.
 */
export type AttributeValue = string | number | boolean | null | undefined;

export interface OtelSpan {
  setAttribute(key: string, value: AttributeValue): unknown;
  setAttributes?(attrs: Record<string, AttributeValue>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException?(exception: { message: string; stack?: string }): unknown;
  end(endTime?: number): unknown;
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, AttributeValue>;
      startTime?: number;
    },
  ): OtelSpan;
}

export const SPAN_STATUS_OK = 1;
export const SPAN_STATUS_ERROR = 2;

export interface OtelExporterOptions {
  tracer: OtelTracer;
  /** Prefix for span names. Default: 'harnesskit.' */
  prefix?: string;
  /** Hook to redact event before attributes are written. */
  redactAttributes?: (key: string, value: AttributeValue) => AttributeValue;
}

const trim = (s: string, max = 500): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export const otelExporter = (opts: OtelExporterOptions): Interceptor => {
  const prefix = opts.prefix ?? 'harnesskit.';
  const redact = opts.redactAttributes ?? ((_k, v) => v);
  const sessionSpans = new Map<string, OtelSpan>();
  const turnSpans = new Map<string, OtelSpan>();
  const callSpans = new Map<string, OtelSpan>();

  const setAttr = (span: OtelSpan, key: string, value: AttributeValue): void => {
    const v = redact(key, value);
    if (v !== undefined) span.setAttribute(key, v);
  };

  return {
    name: 'otel-exporter',
    on(event) {
      switch (event.type) {
        case 'session.start': {
          const span = opts.tracer.startSpan(`${prefix}session`, { startTime: event.ts });
          setAttr(span, 'session.id', event.ids.sessionId);
          if (event.meta) {
            for (const [k, v] of Object.entries(event.meta)) {
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                setAttr(span, `session.meta.${k}`, v);
              }
            }
          }
          sessionSpans.set(event.ids.sessionId, span);
          break;
        }
        case 'session.end': {
          const span = sessionSpans.get(event.ids.sessionId);
          if (span) {
            span.setStatus({ code: SPAN_STATUS_OK });
            span.end(event.ts);
            sessionSpans.delete(event.ids.sessionId);
          }
          break;
        }
        case 'turn.start': {
          const span = opts.tracer.startSpan(`${prefix}turn`, { startTime: event.ts });
          setAttr(span, 'session.id', event.ids.sessionId);
          setAttr(span, 'turn.id', event.ids.turnId);
          setAttr(span, 'gen_ai.system', event.provider);
          setAttr(span, 'gen_ai.request.model', event.model);
          setAttr(span, 'gen_ai.request.message_count', event.request.messages.length);
          if (event.request.tools) {
            setAttr(span, 'gen_ai.request.tool_count', event.request.tools.length);
          }
          turnSpans.set(event.ids.turnId, span);
          break;
        }
        case 'turn.end': {
          const span = turnSpans.get(event.ids.turnId);
          if (span) {
            setAttr(span, 'duration_ms', event.durationMs);
            if (event.response?.stopReason) {
              setAttr(span, 'gen_ai.response.finish_reason', event.response.stopReason);
            }
            span.setStatus({ code: SPAN_STATUS_OK });
            span.end(event.ts);
            turnSpans.delete(event.ids.turnId);
          }
          break;
        }
        case 'usage': {
          const span = turnSpans.get(event.ids.turnId);
          if (span) {
            if (event.usage.inputTokens !== undefined) {
              setAttr(span, 'gen_ai.usage.input_tokens', event.usage.inputTokens);
            }
            if (event.usage.outputTokens !== undefined) {
              setAttr(span, 'gen_ai.usage.output_tokens', event.usage.outputTokens);
            }
            if (event.usage.cacheReadTokens !== undefined) {
              setAttr(span, 'gen_ai.usage.cache_read_tokens', event.usage.cacheReadTokens);
            }
            if (event.usage.costUsd !== undefined) {
              setAttr(span, 'gen_ai.usage.cost_usd', event.usage.costUsd);
            }
          }
          break;
        }
        case 'tool.call.requested': {
          const id = event.ids.callId ?? event.call.id;
          const span = opts.tracer.startSpan(`${prefix}tool.${event.call.name}`, {
            startTime: event.ts,
          });
          setAttr(span, 'session.id', event.ids.sessionId);
          setAttr(span, 'turn.id', event.ids.turnId);
          setAttr(span, 'tool.call_id', id);
          setAttr(span, 'tool.name', event.call.name);
          setAttr(span, 'tool.input', trim(JSON.stringify(event.call.input ?? {})));
          callSpans.set(id, span);
          break;
        }
        case 'tool.call.resolved': {
          const id = event.ids.callId ?? event.call.id;
          const span = callSpans.get(id);
          if (span) {
            const content =
              typeof event.result.content === 'string'
                ? event.result.content
                : JSON.stringify(event.result.content);
            setAttr(span, 'tool.output', trim(content));
            if (event.result.isError) {
              setAttr(span, 'tool.error', true);
              span.setStatus({ code: SPAN_STATUS_ERROR });
            } else {
              span.setStatus({ code: SPAN_STATUS_OK });
            }
            if (event.result.durationMs !== undefined) {
              setAttr(span, 'duration_ms', event.result.durationMs);
            }
            span.end(event.ts);
            callSpans.delete(id);
          }
          break;
        }
        case 'tool.call.denied': {
          const id = event.ids.callId ?? event.call.id;
          const span = callSpans.get(id);
          if (span) {
            setAttr(span, 'tool.denied', true);
            setAttr(span, 'tool.deny_reason', event.reason);
            if (event.policyId) setAttr(span, 'tool.deny_policy', event.policyId);
            span.setStatus({ code: SPAN_STATUS_ERROR, message: `denied: ${event.reason}` });
            span.end(event.ts);
            callSpans.delete(id);
          }
          break;
        }
        case 'error': {
          const span =
            (event.ids.callId && callSpans.get(event.ids.callId)) ||
            turnSpans.get(event.ids.turnId) ||
            sessionSpans.get(event.ids.sessionId);
          if (span) {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: event.message });
            span.recordException?.({ message: event.message });
          }
          break;
        }
      }
    },
    dispose() {
      for (const s of callSpans.values()) s.end();
      for (const s of turnSpans.values()) s.end();
      for (const s of sessionSpans.values()) s.end();
      callSpans.clear();
      turnSpans.clear();
      sessionSpans.clear();
    },
  };
};
