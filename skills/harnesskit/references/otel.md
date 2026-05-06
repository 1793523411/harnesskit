# OpenTelemetry exporter

`@harnesskit/otel` maps `AgentEvent`s to OTel spans so an existing OTel-backed observability stack (Honeycomb, Tempo, Datadog, Jaeger, …) shows agent activity natively.

## Install

```bash
pnpm add @harnesskit/otel @opentelemetry/api
```

`@opentelemetry/api` is a peer dependency. Use whatever SDK setup you already have for your app.

## Usage

```ts
import { trace } from '@opentelemetry/api';
import { otelExporter } from '@harnesskit/otel';

const tracer = trace.getTracer('my-agent');
bus.use(otelExporter({ tracer }));
```

That's it. As events flow through the bus, spans are created and ended.

## Span model

| Span name | Started on | Ended on | Key attributes |
| --- | --- | --- | --- |
| `harnesskit.session` | `session.start` | `session.end` | `session.id` |
| `harnesskit.turn` | `turn.start` | `turn.end` | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `duration_ms`, `gen_ai.response.finish_reason` |
| `harnesskit.tool.<name>` | `tool.call.requested` | `tool.call.resolved` or `tool.call.denied` | `tool.name`, `tool.input` (truncated to 500 chars), `tool.output`, `tool.denied`, `tool.deny_reason`, `tool.deny_policy` |

Denied tool spans get `setStatus({ code: ERROR })` plus the deny reason as message. Errors propagate via `recordException`.

## Attribute names

Compatible with the OTel GenAI semantic conventions where applicable (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`). Tool-related attributes are namespaced under `tool.*` since GenAI conventions don't yet cover tool calls fully.

## Redacting tool inputs

Tool input is truncated to 500 chars by default. To redact specific fields:

```ts
otelExporter({
  tracer,
  redactAttributes: (key, value) => {
    if (key === 'tool.input' && typeof value === 'string' && value.includes('"password"')) {
      return '[REDACTED]';
    }
    return value;
  },
});
```

The redactor runs for every attribute write. Return a different value to substitute, or `undefined` to drop the attribute entirely.

## Custom span name prefix

```ts
otelExporter({ tracer, prefix: 'myapp.' });
// produces: myapp.session, myapp.turn, myapp.tool.<name>
```

## Tying spans to a parent context

Currently the exporter creates spans without an explicit parent — they end up as roots unless your tracer is set up with active-span propagation. Future iteration: optional `parentContext` on the options, or auto-promote based on `context.active()`.
