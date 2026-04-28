# Concepts

Three things to understand: the event bus, the `AgentEvent` shape, and the L1/L2 split.

## The event bus

Everything flows through one `EventBus` instance. You register `Interceptor`s on it; they receive events in order.

```ts
const bus = new EventBus();

bus.use({
  name: 'my-interceptor',
  on(event, ctx) {
    // Read the event. Optionally call ctx.deny() on gateable events.
    // Optionally ctx.emit() new events.
  },
  init?() { /* ... */ },     // called once on first dispatch
  dispose?() { /* ... */ },  // called when bus is disposed
});

await bus.emit({ type: 'session.start', /* ... */ });
await bus.dispose();
```

Bus dispatch is **async and serial** — each interceptor's `on()` is awaited before the next runs. Errors in one interceptor are isolated by default (logged via `onUnhandledError`); pass `failFast: true` to bubble.

## `AgentEvent` — the universal shape

A discriminated union covering everything the harness tracks:

```ts
type AgentEvent =
  // Session lifecycle
  | { type: 'session.start'; ... }
  | { type: 'session.end';   ... }
  // Per-turn (one model API call)
  | { type: 'turn.start';    provider, model, request, ... }
  | { type: 'turn.end';      durationMs, response, ... }
  | { type: 'usage';         usage: { inputTokens, outputTokens, cacheReadTokens, ... } }
  // Tool calls
  | { type: 'tool.call.requested'; call: { id, name, input } }   // ★ gateable
  | { type: 'tool.call.resolved';  call, result }
  | { type: 'tool.call.denied';    call, reason, policyId? }
  // L2-only enrichment
  | { type: 'subagent.spawn'; parentSessionId, childSessionId, purpose? }
  | { type: 'subagent.return'; childSessionId, summary? }
  | { type: 'approval.requested'; call, pendingId }
  | { type: 'approval.resolved';  pendingId, decision }
  | { type: 'context.compacted'; beforeTokens?, afterTokens? }
  // Errors
  | { type: 'error'; message, stage, cause? }
```

Every event carries:

- `ts: number` — milliseconds since epoch
- `ids: { sessionId, turnId, callId? }` — correlation IDs
- `source: 'l1' | 'l2'` — which integration layer produced it (debug only)

## Gateable events

Only `tool.call.requested` is **gateable** — that is, an interceptor calling `ctx.deny(reason)` will cause the bus to short-circuit dispatch and report the deny back to the caller of `emit()`. On any other event, `deny()` is a no-op with a console warning.

This narrow gating surface is intentional: the moment a tool is *about* to run is the only natural place where "should this happen?" makes sense.

## L1 vs L2

The same SDK supports two integration layers because they answer different questions:

| | L1 (`@harnesskit/provider-fetch`) | L2 (`@harnesskit/adapter-*`) |
| --- | --- | --- |
| Hooks into | `globalThis.fetch` | The host framework's hook system |
| Coverage | Any agent that uses the standard model SDK | Only the framework you wrote it for |
| Sees | `turn.start`, `turn.end`, `usage`, `tool.call.requested` | All of L1 + `subagent.spawn`/`return`, `approval.*`, `context.compacted` |
| Deny enforcement | Post-flight: rewrites the next request's `tool_result` to an error | Native: returns `permissionDecision: 'deny'` to the framework |

You can use **L1 only** (universal, framework-agnostic), **L2 only** (richer semantics, only one host), or **both** (events deduped by `turnId` if you care).

## Deny flow at L1 — the trick

L1 sits at the HTTP layer. It cannot stop the model from emitting a `tool_use` block — by the time it sees the response, the model already decided. So denial is **post-flight**:

1. Model emits `tool_use` (id: `toolu_x`, name: `shell`).
2. harnesskit emits `tool.call.requested`. A policy calls `ctx.deny('shell disabled')`.
3. harnesskit emits `tool.call.denied` and stores `{toolu_x → 'shell disabled'}`.
4. Host SDK actually executes the tool (or thinks it did) and sends the next request, which contains `{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '...' }] }`.
5. harnesskit intercepts that outgoing request, finds the matching `tool_use_id`, and rewrites `content` to `[harnesskit denied] shell disabled` with `is_error: true`.
6. The model sees the error in the next response and adapts (typically apologizes, picks a different tool).

This means **deny is best-effort visibility, not bulletproof prevention**. If the host SDK truly executed the tool between steps 1 and 5, that side effect already happened. For hard prevention, prefer L2 (which can return `permissionDecision: 'deny'` before the tool runs) or use a sandbox.

## Policies are just narrowed interceptors

```ts
// Any of these is a Policy
{
  id: 'no-shell',
  decide: (event) => event.call.name === 'shell'
    ? { allow: false, reason: 'no shell' }
    : { allow: true },
};
```

`policyToInterceptor(policy)` turns it into a regular `Interceptor`. The shape is just sugar — under the hood the bus only knows about interceptors.

## Where next

- [Providers](./providers.md) — what each L1 provider sees and how it normalizes
- [Policies](./policies.md) — write your own
- [Adapters](./adapters.md) — how each L2 adapter wires into its host
