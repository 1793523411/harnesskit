# Next iterations — backlog of work options

A running log of "things we could do next" so we don't lose them between
sessions. When picking the next round, look here first. Each entry is
sized roughly so we can pick by appetite.

Status legend:
- 📋 planning — has its own doc / spec
- 🟡 medium — meaningful work, single-round-sized
- 🟢 small — half-day or less
- 🔴 large — multi-round, decompose first

---

## Provider coverage

### 🔴 Bedrock per-model `/invoke` dispatcher
**See `docs/notes/bedrock-invoke-todo.md` for the full spec.**

Current state: the Bedrock Converse API (`/converse` + `/converse-stream`)
is fully wired. The `/model/<id>/invoke` and `/invoke-with-response-stream`
paths use per-model wire formats (Anthropic / Llama / Mistral / Titan /
Cohere) and aren't claimed by any provider yet.

Estimated 600–800 LOC + ~15 tests. The Anthropic-on-Bedrock streaming
case in particular is interesting: payload is base64-encoded Anthropic
SSE inside AWS Event Stream framing — would benefit from extracting the
Anthropic SSE consumer into a shared helper.

### 🟡 `runAgentStream` multi-provider
Right now `runAgentStream` only speaks OpenAI Chat Completions. Add
native Anthropic Messages and Gemini `:generateContent` paths so users
on those providers don't have to either (a) use the OpenAI-Compat facade
through a proxy or (b) hand-roll a streaming loop.

Approach: make `runAgentStream` provider-aware via an explicit
`provider: 'openai' | 'anthropic' | 'gemini'` option (or detect from
`baseUrl`). Reuse the existing stream consumers from
`@harnesskit/provider-fetch`. Most of the work is mapping each
provider's "tool call" into the same `RunAgentStreamChunk` shape.

Why deferred: native Anthropic users typically reach for the
`@anthropic-ai/sdk` directly (which is intercepted by L1 anyway).
Value is real but narrower than it first looked.

---

## Trace viewer

### 🟢 URL hash for selected event
`#event-a-42` or `#event-b-7` in the URL fragment, restored on load,
written on selection. Lets you bookmark / share specific events.
Pairs naturally with comparison mode (`#cmp-a-42-vs-b-15`).

### 🟢 Severity-aware error styling
Errors from different stages have different blast radius — surface them
with a banner at the top of the timeline so they aren't lost in a long
scroll.

### 🟡 Diff alignment in comparison mode
Today comparison mode is stat-level only; events from each side render
in their own column without alignment. A "best-effort" event matcher
(by tool_use_id, by call_id, by composite key) plus side-by-side
aligned rendering would surface "this turn took 800ms in run A but
2100ms in run B" at-a-glance.

Hard part: cross-trace event correlation when ids don't match (e.g.
session ids differ across runs). Probably lean on `(turn-index,
event-type)` tuples.

### 🟢 Replay time-shifting in compare mode
Currently replay is single-trace only. A "synchronized scrub" across
both timelines would be useful for "replay both side-by-side at 4×".

---

## Policy + harness

### 🟢 `tokenBudget` / `costBudget` windowed mode
Right now `tokenBudget` caps the running total per session. Add a
`window: { ms: number }` option so the same builtin can do "30k tokens
per 60s" (the rateLimit pattern, but expressed as a budget). Avoids
the user having to compose `tokenBudget` + `rateLimit`.

### 🟢 `rateLimit` split caps
Today `tokensPerMin` is input+output combined. Add separate
`inputTokensPerMin` / `outputTokensPerMin` caps for providers whose
429s key off direction (e.g. some OpenAI tiers cap output separately).

### 🟡 `createHarness({...})` convenience wrapper
Bundle the common 3-line setup (EventBus + recorder + interceptor)
into one call:
```ts
const harness = createHarness({
  policies: [...],
  rewriteToolResults: redactPiiInToolResults({ ... }),
});
// harness.bus, harness.dispose(), harness.report()
```
Optional but a nice ergonomic win for "I just want to start".

### 🟢 `diagnose()` host-detect probe
Extension to `createDiagnostic`: given a URL, compute "would this URL
be intercepted by which provider, with what host config?" Useful for
debugging custom proxy setups before you commit a hostname to
`customHosts`.

### 🟡 Approval flow primitives
There are `approval.requested` / `approval.resolved` event types
already, but no out-of-the-box helpers. Add:
- `requireApprovalUI({ wait: (call) => Promise<boolean> })` interceptor
- A small CLI prompt helper in examples
- Webhook-flavored approval pattern in recipes.md

### 🟢 Spend tracker policy
`trackSpend(pricer)` — accumulates dollars per session and exposes
`.report()` for the runner to surface. Different from `costBudget`
which DENIES; this just OBSERVES.

---

## Adapters

### 🟡 LangGraph state-graph propagation
The adapter currently surfaces LLM/tool callbacks. State transitions
(StateGraph node enter/exit, conditional edges) aren't yet emitted as
`subagent.spawn` / `subagent.return`. Doing this needs hooking into
`StateGraph.addNode` / `StateGraph.addEdge`, which is more invasive.

Workaround documented today: emit those manually from your node
functions.

### 🟡 Vercel AI SDK v4+ catchup
The adapter targets v3-era surface. v4 streaming primitives changed —
audit and update.

### 🟢 Mastra adapter
Mastra is a TypeScript agent framework with growing adoption. A shim
layer that maps its observability hooks to harnesskit events would
mirror the LangGraph / OpenAI-Agents adapters.

---

## Documentation

### 🟢 "Why harnesskit" recipes
Concrete migration recipes: "switching from LangFuse to harnesskit",
"adding harnesskit on top of an existing OpenAI SDK app",
"plugging harnesskit into Vercel AI Gateway".

### 🟢 Architecture diagram
A single SVG / mermaid showing L1 (wire) ↔ L2 (semantic) ↔
interceptors ↔ recorder. Currently described in concepts.md but no
visual.

### 🟢 Common-mistakes guide
Sibling to `createDiagnostic` — a doc that lists the 5 most common
"why isn't this working" failures and how to detect them.

---

## Performance / quality

### 🟢 Backpressure on AWS Event Stream parser
Today the parser buffer grows unbounded if frames stall. AWS frames
are <1MB so it's fine in practice, but bounded backpressure (a
sliding 4MB window) would be safer.

### 🟢 CRC32 validation on Event Stream frames
Currently best-effort. Add real CRC32 with the IEEE polynomial
(0xEDB88320) and reject frames whose CRCs don't match. Update
`encodeFrameForTest` to compute real CRCs in lockstep.

### 🟢 Concurrent emit fairness
EventBus `emit` is serial across interceptors. If a slow interceptor
back-pressures the bus, every other interceptor waits behind it.
A "fan-out emit with timeout per interceptor" mode would help long-
running observers (e.g. OTel exporters with retries).

---

## Testing

### 🟡 Real-API integration tests
Today most tests are mock-target. Add a `--with-real-api` mode that
runs a small set against actual providers (gated by env vars). Useful
for catching wire-format drift before users hit it.

### 🟢 Cross-platform fetch tests
Verify `installFetchInterceptor` works in Bun, Deno, Cloudflare
Workers — currently only tested under Node.

---

## Decision queue (revisit before starting these)

- **Bedrock single tag vs split**: one `bedrock` provider with both
  Converse + invoke surfaces, or two providers (`bedrock`,
  `bedrock-invoke`)? Affects detect.ts, BUILTIN_PROVIDERS, and how
  users configure customHosts.
- **`runAgentStream` provider option vs auto-detect**: detect from
  baseUrl pattern, or require explicit `provider:` option? Auto-detect
  is more ergonomic but opaque when something goes wrong.
- **`createHarness` API shape**: include `recorder` by default? Many
  users want it; some don't. Default-on with opt-out matches `runAgent`
  today.
