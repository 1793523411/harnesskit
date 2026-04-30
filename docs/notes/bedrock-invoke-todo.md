# TODO — Bedrock per-model `/invoke` dispatcher

The Bedrock Converse API (`*/converse`, `*/converse-stream`) is fully
wired in `packages/provider-fetch/src/providers/bedrock/`. The other
half of Bedrock — the per-model `/model/<id>/invoke` and
`/invoke-with-response-stream` paths — is **not** claimed by any
provider today. This file is the running spec for the work.

## Why deferred

Each foundation model on Bedrock uses a different `/invoke` request /
response shape. The Converse API was designed to paper over this and
covers most use cases, so most users should reach for that first.
`/invoke` matters for:

- Models or features that haven't been ported to Converse yet (e.g.
  certain Claude tools API generations, Llama variants, embedding
  models).
- Lower-latency paths where the Converse wrapper adds overhead.
- Legacy code that was already on `/invoke` before Converse existed.

## Wire formats to support

### Anthropic Claude on Bedrock (`anthropic.claude-*`)

Body shape is **almost** the standard Anthropic Messages API but with
two wrinkles:

```json
{
  "anthropic_version": "bedrock-2023-05-31",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "hi" }],
  "tools": [...]
}
```

- `model` is **not** in the body — it's in the URL path.
- `anthropic_version` is required (Bedrock-specific value).
- Old Claude 2.x uses `prompt`/`completion` (`anthropic.claude-v2`,
  `anthropic.claude-instant-v1`). We can either emit a hard-fail
  detection or also normalize this format.

Streaming via `/invoke-with-response-stream` reuses Bedrock's AWS Event
Stream binary framing. Inside each frame, the payload is:

```json
{ "bytes": "<base64 of the next Anthropic SSE chunk>" }
```

So the parsing is:
1. AWS Event Stream framer (we have this in
   `providers/bedrock/eventstream.ts`).
2. For each frame: `Buffer.from(payload.bytes, 'base64').toString()` →
   one line of an Anthropic SSE stream.
3. Hand that line to a slightly-tweaked Anthropic SSE consumer.

Plan: extract the Anthropic SSE inner consumer into a helper that
takes already-split SSE events; reuse it across native Anthropic
(`text/event-stream`), Vertex Anthropic (same), and Bedrock
(base64-in-eventstream).

### Llama on Bedrock (`meta.llama*`)

```json
{
  "prompt": "<prompt>",
  "max_gen_len": 512,
  "temperature": 0.5,
  "top_p": 0.9
}
```

Response:

```json
{
  "generation": "<text>",
  "prompt_token_count": 42,
  "generation_token_count": 100,
  "stop_reason": "stop"
}
```

No tool support in older Llama models on Bedrock. Newer
`meta.llama3-*` instruction models support function calling but need
prompt templates we'd have to encode.

Streaming chunks (inside Event Stream payloads):

```json
{ "generation": "<delta>", "stop_reason": null, "generation_token_count": 5 }
```

### Mistral on Bedrock (`mistral.mistral-*`, `mistral.mixtral-*`)

```json
{
  "prompt": "<INST> ... </INST>",
  "max_tokens": 512,
  "temperature": 0.5,
  "top_p": 0.9
}
```

Response:

```json
{
  "outputs": [
    { "text": "<text>", "stop_reason": "stop" }
  ]
}
```

Tool calling on the newer Mistral Large variant is JSON-mode; the
model emits a JSON object with a `tool_calls` field.

### Amazon Titan (`amazon.titan-text-*`)

```json
{
  "inputText": "<prompt>",
  "textGenerationConfig": {
    "maxTokenCount": 512,
    "temperature": 0.7,
    "topP": 0.9,
    "stopSequences": []
  }
}
```

Response:

```json
{
  "inputTextTokenCount": 12,
  "results": [
    {
      "tokenCount": 100,
      "outputText": "<text>",
      "completionReason": "FINISH"
    }
  ]
}
```

No tool calling in current Titan text models.

### Cohere Command (`cohere.command-*`)

```json
{
  "prompt": "<prompt>",
  "max_tokens": 200,
  "temperature": 0.75,
  "p": 0.01,
  "k": 0,
  "stop_sequences": [],
  "return_likelihoods": "NONE"
}
```

Response:

```json
{
  "id": "...",
  "generations": [
    { "id": "...", "text": "<text>", "finish_reason": "COMPLETE" }
  ],
  "prompt": "..."
}
```

Cohere Command-R and R+ have a different (chat-style) shape with tool
support. They're listed separately on Bedrock.

## Implementation plan

1. **Detector** in `providers/bedrock-invoke/detect.ts`:
   - Match `bedrock-runtime.<region>.amazonaws.com` host.
   - Path matches `/model/<id>/invoke` or
     `/model/<id>/invoke-with-response-stream`.
   - Extract the model id, then dispatch by prefix to a per-model
     normalizer.

2. **Sub-providers** as siblings of the main bedrock provider:
   ```
   providers/bedrock-invoke/
     detect.ts                 // shared
     types.ts                  // ProviderImpl + helpers
     index.ts                  // dispatcher → registers as one provider
     anthropic.ts              // claude-*
     llama.ts                  // meta.llama-*
     mistral.ts                // mistral.*
     titan.ts                  // amazon.titan-*
     cohere.ts                 // cohere.command-*
   ```
   Each sub-provider exposes the per-model normalizer pieces and the
   dispatcher routes by model-id prefix at parseRequest time.

3. **Streaming**: reuse `providers/bedrock/eventstream.ts` (already
   handles binary framing). For Anthropic: base64-decode each frame's
   payload as an Anthropic SSE chunk and feed into the existing
   Anthropic SSE consumer. For others: parse the JSON payload directly.

4. **Tool support**: Anthropic and Mistral get full tool-use
   normalization. Llama / Titan / Cohere either get text-only or are
   marked as "tool-calling not supported on this model" and bail.

5. **Tag**: probably `bedrock-invoke` (separate from `bedrock` so
   downstream consumers can opt one or the other). Or one flat
   `bedrock` tag with both surfaces — TBD when we get there.

## Estimate

- Anthropic on /invoke: ~150 LOC + tests (payload reuse from native
  Anthropic provider helps).
- Llama / Titan / Cohere: ~80 LOC each (no tool calls, simpler).
- Mistral with tool calling: ~150 LOC (custom tool-call parser).
- Streaming reuse infrastructure: ~50 LOC of shared base64-eventstream
  glue.

Roughly 600–800 LOC + ~15 tests. Worth doing as one branch, not
multiple commits, so the dispatcher table doesn't have churn.

## Decision points to revisit before starting

- Single `bedrock` provider with two surfaces (Converse + invoke) vs
  two providers (`bedrock` + `bedrock-invoke`)? Two-provider keeps
  detect logic per-file but means two BUILTIN entries to maintain.
- Do we register every model family even when no consumers want them?
  Probably yes — detection is cheap and the alternative (config flag)
  is a footgun.
- Should the dispatcher emit a clear `error` when an unknown model
  prefix shows up at `/invoke`? Today we'd silently pass through.
  Probably worth adding a one-line warning for diagnosability.
