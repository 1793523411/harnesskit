# Roadmap

What's not in v0 yet, and why.

## AWS Bedrock provider

**Status**: Not natively supported. Pluggable workaround documented below.

Bedrock has two wire formats:
- **Per-model API** (`/model/<id>/invoke` or `/model/<id>/invoke-with-response-stream`) — model-specific (Anthropic Claude on Bedrock looks Anthropic-ish but with `prompt` field instead of `messages` for older Claude 2.x).
- **Converse API** (`/model/<id>/converse`) — universal, OpenAI-style messages.

Why it's not a built-in provider:

1. **Auth**: AWS Sig V4 signing is non-trivial — credential resolution, date scope, signed headers. Adding it to harnesskit means depending on either `@aws-sdk/signature-v4` (heavyweight) or rolling our own (high blast radius).
2. **Wire variance**: Per-model wire format differs across Claude / Llama / Mistral / Titan etc. Each would need its own normalizer.

**Workaround that works today**:

```ts
// Use the AWS SDK to make the call (it handles sigv4); harnesskit does NOT
// see this — but you can manually emit events from the bedrockClient response.
//
// OR: use a Bedrock-compatible proxy (e.g. LiteLLM, Cloudflare AI Gateway)
// that exposes Anthropic Messages or OpenAI Chat Completions. Then add the
// proxy host to customHosts and harnesskit picks it up automatically.
installFetchInterceptor({
  bus,
  customHosts: { openai: ['my-litellm-bedrock-proxy.internal'] },
});
```

A proper built-in `bedrockProvider` would need:
- A `signRequest` option on `FetchInterceptorOptions` taking `(req: { url, headers, body }) => Promise<{ headers }>` — letting users plug in their own AWS SDK / `aws4fetch`.
- Wire-format detect: `*/converse` → OpenAI normalize, `*/invoke` → per-model dispatcher.

PRs welcome.

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

- Streaming output for `runAgent` (currently buffers and returns final text only).
- Web trace viewer: tree view (parent/child relationships from `subagent.spawn`), comparison mode (two traces side-by-side), search-by-content.
- Replay: support time-shifting (replay at original wall-clock pace) for live UI demos.

## Recently shipped

- **Active tool-result redaction.** `installFetchInterceptor({ rewriteToolResults })` runs after the deny rewrite pass; `redactPiiInToolResults` from `@harnesskit/policy` swaps PII matches for `[REDACTED]` before the model sees the result. Pair with `piiScan` (input gating) to cover both directions. Implemented for Anthropic, OpenAI Chat, OpenAI Responses, and Gemini.
- **Mid-stream cancel for Gemini and OpenAI Responses.** See above.
