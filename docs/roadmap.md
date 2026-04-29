# Roadmap

What's not in v0 yet, and why.

## AWS Bedrock provider

**Status**: Auth is solved (`signRequest` hook). Wire-format detect for `*/converse` and `*/invoke` is still pending.

Bedrock has two wire formats:
- **Converse API** (`/model/<id>/converse`) — universal, OpenAI-style messages.
- **Per-model API** (`/model/<id>/invoke` or `/model/<id>/invoke-with-response-stream`) — model-specific (Anthropic Claude on Bedrock looks Anthropic-ish; older Claude 2.x uses `prompt` field).

Auth was the hard part — AWS Sig V4 signing — and is now pluggable via the `signRequest` hook. You bring `aws4fetch` or `@aws-sdk/signature-v4`; harnesskit hands you the final body and merges your returned headers:

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
  customHosts: { anthropic: ['bedrock-runtime.us-east-1.amazonaws.com'] },
  signRequest: async ({ url, method, headers, body }) => {
    const signed = await aws.sign(new Request(url, { method, headers, body }));
    return { headers: Object.fromEntries(signed.headers) };
  },
});
```

What still needs work for native Bedrock:
- A wire-format detector that recognizes `bedrock-runtime.*.amazonaws.com` and routes `*/converse` to OpenAI-style normalize, `*/invoke` to a per-model dispatcher (Claude / Llama / Mistral / Titan each need their own).
- A streaming consumer for `invoke-with-response-stream` (each chunk arrives base64-encoded inside an EventStream framing).

In the meantime, a Bedrock-compatible proxy (LiteLLM, Cloudflare AI Gateway) plus `customHosts` is still the lowest-friction path.

## Google Vertex AI provider

**Status**: Partially works through the existing Gemini provider.

Vertex's Gemini endpoint:
```
https://<region>-aiplatform.googleapis.com/v1/projects/<id>/publishers/google/models/<model>:generateContent
```

The path ends with `:generateContent`, which the Gemini provider already detects. Add the regional hostname to customHosts:

```ts
installFetchInterceptor({
  bus,
  customHosts: { google: ['us-central1-aiplatform.googleapis.com'] },
});
```

What's missing: GCP auth via OAuth2 / service account access tokens. Use the Google Auth Library to obtain a Bearer token and add it to your fetch headers — harnesskit doesn't get involved in auth.

Anthropic Claude on Vertex uses a similar URL pattern but with `:rawPredict` (different path). Not yet detected by harnesskit. Needs its own provider entry.

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

- Web trace viewer: tree view (parent/child relationships from `subagent.spawn`), comparison mode (two traces side-by-side), search-by-content.
- Replay: support time-shifting (replay at original wall-clock pace) for live UI demos.
- Anthropic Claude on Vertex (`:rawPredict`) — Gemini-style `:generateContent` already routes; Claude on Vertex uses a different path so still needs its own provider entry.
- Bedrock wire-format detector + per-model dispatcher (auth is now plug-in via `signRequest`).

## Recently shipped

- **Streaming runner** — `runAgentStream` returns an `AsyncGenerator` yielding `text.delta`, `reasoning.delta`, `tool.call.{started,finished}`, `round.end`, and a final `done` chunk with the full `RunAgentResult`. Same harness applies; same buffered result shape at the end. See `docs/runner.md` and `examples/src/demos/12-streaming-runner.ts`.
- **`signRequest` hook** — let callers compute auth headers from the final serialized body. Recipe in the Bedrock section above; demo at `examples/src/showcase-sign-request.ts`.
- **Multi-rewriter chains + exception fallback** — `rewriteToolResults` accepts a single rewriter or an array. Each runs in order, output of one feeds the next. A throw is caught, emitted as an `error` event, and treated as no-op for that block. Showcase at `examples/src/showcase-rewriter-chain.ts`.
- **Audit hook on `redactPiiInToolResults`** — pass `audit: ({toolUseId, matches}) => …` to log/track redactions while still actively scrubbing. Audit failures never break redaction.
- **Active tool-result redaction.** `installFetchInterceptor({ rewriteToolResults })` runs after the deny rewrite pass; `redactPiiInToolResults` from `@harnesskit/policy` swaps PII matches for `[REDACTED]` before the model sees the result. Pair with `piiScan` (input gating) to cover both directions. Implemented for Anthropic, OpenAI Chat, OpenAI Responses, and Gemini.
- **Mid-stream cancel for Gemini and OpenAI Responses.** See above.
