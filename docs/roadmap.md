# Roadmap

What's not in v0 yet, and why.

## AWS Bedrock provider

**Status**: Converse API + Sig V4 auth shipped. `/invoke` per-model + Event Stream streaming still pending.

What's in:
- `bedrock-runtime.<region>.amazonaws.com/model/<modelId>/converse` is detected automatically (any region — host regex covers them all).
- `BedrockRequest` / `BedrockResponse` types, normalize, applyDeny, applyContentRewrites all live in `packages/provider-fetch/src/providers/bedrock/`.
- Model id is extracted from the URL path (Bedrock URL-encodes `:`; we decode it back).
- `signRequest` hook handles AWS Sig V4 — bring `aws4fetch` or `@aws-sdk/signature-v4`:

```ts
import { AwsClient } from 'aws4fetch';
const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  region: 'us-east-1',
  service: 'bedrock',
});
installFetchInterceptor({
  bus,
  signRequest: async ({ url, method, headers, body }) => {
    const signed = await aws.sign(new Request(url, { method, headers, body }));
    return { headers: Object.fromEntries(signed.headers) };
  },
});
```

What's still pending:
- **Per-model `/invoke` API** — `/model/<id>/invoke` and `/model/<id>/invoke-with-response-stream` use model-specific wire formats (Claude / Llama / Mistral / Titan each different). Detection deliberately doesn't claim these — they need their own dispatchers.

What's now in for streaming:
- **`/converse-stream`** uses AWS Event Stream binary framing (`application/vnd.amazon.eventstream`): 4-byte total length, 4-byte headers length, prelude CRC, headers, JSON payload, message CRC. The parser in `packages/provider-fetch/src/providers/bedrock/eventstream.ts` reads frames across chunk boundaries and yields `{headers, payload}`. Bedrock chunk types (`messageStart`, `contentBlock{Start,Delta,Stop}`, `messageStop`, `metadata`) assemble into the same `BedrockResponse` the non-streaming path produces. Mid-stream cancel fires when a `toolUse` block completes (`contentBlockStop` for a tool block). CRC validation is best-effort — we frame, we don't validate.

## Google Vertex AI provider

**Status**: Both Gemini and Anthropic Claude on Vertex route automatically.

- **Gemini on Vertex** (`:generateContent` / `:streamGenerateContent`) is picked up by the Gemini provider. Add the regional hostname to `customHosts.google`:
  ```ts
  installFetchInterceptor({
    bus,
    customHosts: { google: ['us-central1-aiplatform.googleapis.com'] },
  });
  ```
- **Anthropic Claude on Vertex** (`:rawPredict` / `:streamRawPredict` under `/publishers/anthropic/models/...`) is detected automatically — no `customHosts` entry needed; the regex `^[a-z0-9-]+-aiplatform\.googleapis\.com$` matches any region. Vertex Claude doesn't carry `model` in the request body (it's in the URL); harnesskit pulls it out for you and `turn.start.model` reflects it.

Auth in both cases: bring your own GCP OAuth2 / service-account access token in the request `Authorization` header — harnesskit doesn't fetch tokens for you. Use the Google Auth Library (`google-auth-library`) and inject the Bearer header from your fetch wrapper.

## LangGraph adapter — full StateGraph integration

**Status**: Callback-handler-level support shipped. State propagation TBD.

`@harnesskit/adapter-langgraph` exports `harnesskitCallbacks(bus)` that you pass via `RunnableConfig.callbacks`. This catches LLM and tool events fine. But LangGraph state transitions and conditional edges are not yet surfaced as `subagent.spawn` / `subagent.return` events. To do that we'd need to hook into `StateGraph.addNode` / `StateGraph.addEdge` directly — invasive.

Workaround: emit those manually from your node functions if you need them.

## True mid-stream cancellation across all providers

**Status**: Anthropic, Gemini, OpenAI Responses. Chat Completions still N/A.

- **Anthropic**: `content_block_stop` cleanly delineates when a `tool_use` is fully assembled. We fire `tool.call.requested` from `consumeAnthropicStream`, get a deny decision, and cancel the upstream connection before more tokens are generated.
- **Gemini**: a `functionCall` part arrives complete inside a single chunk's `content.parts[]` (args are not split). When a new functionCall key appears in `consumeGeminiStream`, it fires the eager hook — same abort path as Anthropic.
- **OpenAI Responses**: deltas finalize via `response.output_item.done`. For `function_call` items we fire the eager hook there.
- **OpenAI Chat Completions**: tool_calls are spread across many delta chunks; by the time a tool call is fully assembled, `finish_reason: 'tool_calls'` has typically arrived too. Mid-stream cancel saves nothing — left as-is.

## Real sandbox (Docker / Firecracker / WebContainer)

**Out of scope.**

harnesskit's deny semantics are wire-level (rewrite the next request's tool_result) or hook-level (return `permissionDecision: 'deny'`). Both stop the *model* from seeing the result of a forbidden action. Neither prevents the *host* from actually executing it — that's a sandbox problem, not a harness problem.

For real prevention (e.g., model emits `shell rm -rf /`, host SDK is going to actually run it), use a sandbox at the tool-execution boundary: Docker, Firecracker, WebContainer, or your own jailed runtime. harnesskit's `tool.call.denied` event is the trigger; the sandbox is the wall.

## Smaller improvements queued

- Bedrock per-model `/invoke` dispatcher (planning doc: `docs/notes/bedrock-invoke-todo.md`).

## Recently shipped

- **Trace viewer comparison mode** — load two traces, get a side-by-side timeline plus a top "diff bar" with deltas (events, turns, tool calls, denied, tokens, errors, duration). Color: green = improvement, red = regression. Each side keeps its own session-collapse state. Click any event from either side to inspect it (the detail pane shows which side it came from).
- **Trace viewer replay (time-shifted)** — single-trace mode adds a Play/Pause + speed selector (0.25× / 1× / 4× / instant). When playing, future events fade to 18% opacity, the event under the cursor gets an accent border, and the detail pane auto-advances. The cursor label shows `t=<ms>/<total>ms`. Disabled in compare mode (one timeline at a time).
- **Trace viewer tree view + keyboard nav** — `apps/trace-viewer/index.html` gains a Flat/Tree toggle. In Tree mode, sessions group together with child agents nested under their `subagent.spawn` parent (recursive — N levels deep). `j`/`k` navigate between events, scrolling the selected one into view. Session headers collapse on click. The bundled demo trace now includes a parent → child research-agent spawn so you can see tree mode work without loading a real trace.
- **Bedrock `/converse-stream` Event Stream parser** — full binary-framing parser in `providers/bedrock/eventstream.ts`. Mid-stream cancel on toolUse completion. Server `exception` frames surface as `error` events. CRC validation is best-effort — we frame, we don't validate.
- **AWS Bedrock Converse API** — detect, normalize, deny rewrite, content rewrite all live. Pair with `signRequest` for Sig V4. Both `/converse` (non-streaming) and `/converse-stream` (streaming) work fully now. Showcase: `examples/src/showcase-bedrock.ts`.
- **Anthropic Claude on Vertex** — `:rawPredict` and `:streamRawPredict` URLs on `*-aiplatform.googleapis.com` detect automatically. Model is extracted from the URL path (Vertex Claude doesn't put it in the body). Streaming is tagged from path so `:streamRawPredict` wires through the same SSE consumer as native Anthropic.
- **Streaming runner** — `runAgentStream` returns an `AsyncGenerator` yielding `text.delta`, `reasoning.delta`, `tool.call.{started,finished}`, `round.end`, and a final `done` chunk with the full `RunAgentResult`. Same harness applies; same buffered result shape at the end. See `docs/runner.md` and `examples/src/demos/12-streaming-runner.ts`.
- **`signRequest` hook** — let callers compute auth headers from the final serialized body. Recipe in the Bedrock section above; demo at `examples/src/showcase-sign-request.ts`.
- **Multi-rewriter chains + exception fallback** — `rewriteToolResults` accepts a single rewriter or an array. Each runs in order, output of one feeds the next. A throw is caught, emitted as an `error` event, and treated as no-op for that block. Showcase at `examples/src/showcase-rewriter-chain.ts`.
- **Audit hook on `redactPiiInToolResults`** — pass `audit: ({toolUseId, matches}) => …` to log/track redactions while still actively scrubbing. Audit failures never break redaction.
- **Active tool-result redaction.** `installFetchInterceptor({ rewriteToolResults })` runs after the deny rewrite pass; `redactPiiInToolResults` from `@harnesskit/policy` swaps PII matches for `[REDACTED]` before the model sees the result. Pair with `piiScan` (input gating) to cover both directions. Implemented for Anthropic, OpenAI Chat, OpenAI Responses, and Gemini.
- **Mid-stream cancel for Gemini and OpenAI Responses.** See above.
