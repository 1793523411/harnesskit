# Providers (L1)

`@harnesskit/provider-fetch` patches `globalThis.fetch` to recognize four model APIs out of the box. All other URLs pass through untouched.

## Provider matrix

| Provider tag | Default host | Path match | Wire format | Streaming | Deny rewrite target |
| --- | --- | --- | --- | --- | --- |
| `anthropic` | `api.anthropic.com`, `*-aiplatform.googleapis.com` | `*/v1/messages`, `*/publishers/anthropic/models/*:rawPredict`, `*:streamRawPredict` | Anthropic Messages | SSE with named events | `tool_result` block in user message |
| `openai` | `api.openai.com` | `*/chat/completions` | OpenAI Chat Completions | SSE data lines (+ `[DONE]`) | `role: 'tool'` message |
| `openai-responses` | `api.openai.com` | `*/v1/responses` | OpenAI Responses API | SSE with named events (`response.*`) | `function_call_output` item |
| `openrouter` | `openrouter.ai` | `*/chat/completions` | OpenAI-compatible | Same as `openai` | Same as `openai` |
| `google` | `generativelanguage.googleapis.com`, `*-aiplatform.googleapis.com` | `*:generateContent`, `*:streamGenerateContent` | Gemini API | SSE data lines | `functionResponse` part in user content |
| `bedrock` | `bedrock-runtime.<region>.amazonaws.com` | `*/converse`, `*/converse-stream` (stream stub for now) | Bedrock Converse | (Event Stream framing — pending) | `toolResult` block in user message |

Path matching uses `endsWith` so proxy gateways with non-standard prefixes are handled (e.g. Volcengine's `/api/v3/chat/completions`, Groq's `/openai/v1/chat/completions`). Hosts are still matched strictly — pass `customHosts` to add proxies.

All four are tested for both **non-streaming** and **streaming** paths, including deny-rewrite across requests, plus reasoning-model support (`reasoning_content` field — see below).

## Install + usage

```ts
import { EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const bus = new EventBus();
const dispose = installFetchInterceptor({ bus });
// Later: dispose();
```

## Options

```ts
interface FetchInterceptorOptions {
  bus: EventBus;

  /** Limit to a subset. Default: all four. */
  providers?: readonly ProviderTag[];

  /** Override target. Default: globalThis. Pass {fetch: yourFn} for testing. */
  target?: { fetch: typeof fetch };

  /** Stable session ID resolver. Default: one fresh sessionId per install(). */
  getSessionId?: () => string;

  /** Header redaction. Default: 'standard' (auth/x-api-key/cookie -> [REDACTED]). */
  redactHeaders?: 'all' | 'standard' | 'none' | ((name: string, value: string) => string | null);

  /** Attach raw provider request/response on emitted events. Default: false. */
  includeRaw?: boolean;

  /** Recognize additional hosts as the named provider (proxies, gateways). */
  customHosts?: {
    anthropic?: readonly string[];
    openai?: readonly string[];
    openrouter?: readonly string[];
    google?: readonly string[];
    bedrock?: readonly string[];
  };
}
```

## What each provider emits

For both streaming and non-streaming, the event sequence is identical:

```
turn.start  → turn.end  → usage  → tool.call.requested (× N tool_uses in response)
```

Each event has a normalized `request`/`response` shape (see `@harnesskit/core` `NormalizedRequest`/`NormalizedResponse`) plus `raw` if `includeRaw: true`.

## Deny rewrite — how each provider keys it

When the bus denies a `tool.call.requested`, harnesskit stores `{tool_id → reason}`. On the **next outgoing request** of the same provider, it scans for the matching tool result and replaces its content:

| Provider | Key | Where |
| --- | --- | --- |
| `anthropic` | `tool_use_id` | `messages[].content[].tool_use_id` (block type `tool_result`) |
| `openai` | `tool_call_id` | `messages[].tool_call_id` (role `tool`) |
| `openai-responses` | `call_id` | `input[].call_id` (item type `function_call_output`) |
| `openrouter` | `tool_call_id` | (same as `openai`) |
| `bedrock` | `toolUseId` | `messages[].content[].toolResult.toolUseId` (status set to `error`) |
| `google` | `id` (or synthesized `gemini_fc_<name>`) | `contents[].parts[].functionResponse` |

After rewriting, the entry is removed from the deny store — re-emission of the same `tool_use_id` (rare but possible) won't re-deny.

## Custom hosts (proxies, gateways, alternative providers)

Many teams run a proxy in front of the real API, or use OpenAI-compatible providers other than OpenAI itself. Add their host to `customHosts.<tag>`:

```ts
installFetchInterceptor({
  bus,
  customHosts: {
    anthropic: ['llm-gateway.internal'],
    openai: [
      'my-litellm.example.com',
      'ark.cn-beijing.volces.com',  // Volcengine (Doubao, DeepSeek)
      'api.groq.com',                // Groq
      'api.together.xyz',            // Together
    ],
  },
});
```

Now `https://llm-gateway.internal/v1/messages` is treated as Anthropic; `https://ark.cn-beijing.volces.com/api/v3/chat/completions` is treated as OpenAI Chat Completions. Default hosts are still recognized.

### Verified OpenAI-compatible deployments

The path matcher (`endsWith('/chat/completions')`) plus `customHosts.openai` covers:

| Provider | Host | Notes |
| --- | --- | --- |
| Volcengine (火山引擎) | `ark.cn-beijing.volces.com` | DeepSeek, Doubao, Qwen — including reasoning models |
| Groq | `api.groq.com` | path `/openai/v1/chat/completions` |
| Together AI | `api.together.xyz` | |
| Anyscale Endpoints | `api.endpoints.anyscale.com` | |
| Any LiteLLM proxy | (your host) | |

If your provider uses a different path entirely (e.g. Bedrock's `/model/.../invoke`), you'll need a new ProviderImpl — see "Adding a new provider" below.

## Reasoning models (`reasoning_content`)

DeepSeek, Doubao, Qwen-Reasoning and similar models return a separate `reasoning_content` field on the assistant message in addition to `content`. harnesskit normalizes this to a `thinking` block in the `NormalizedResponse`:

```ts
// turn.end event
{
  type: 'turn.end',
  response: {
    content: [
      { type: 'thinking', text: 'Let me work through this step by step...' },
      { type: 'text',     text: 'The answer is 4.' },
    ],
    stopReason: 'stop',
  },
  // ...
}
```

Streaming `delta.reasoning_content` is reassembled across SSE chunks the same way `delta.content` is. No configuration needed — works automatically when the upstream model emits it.

## Header redaction

Captured raw events (when `includeRaw: true`) include request headers. Redaction options:

```ts
redactHeaders: 'standard'  // default — redact auth, x-api-key, cookie, openai-organization, etc.
redactHeaders: 'all'       // every header value -> [REDACTED]
redactHeaders: 'none'      // pass through verbatim (DANGER — only for local debugging)
redactHeaders: (name, value) => name === 'x-org' ? value.slice(0,4) + '***' : value,
                            // custom function — return null to drop the header entirely
```

Standard redaction list: `authorization`, `x-api-key`, `openai-organization`, `openai-project`, `x-goog-api-key`, `cookie`, `set-cookie`.

## Limits and gotchas

- **`fetch` patching only**. If your SDK uses `axios` or its own HTTP client, L1 won't see it. Most modern AI SDKs use `globalThis.fetch`; verify yours does.
- **Body must be a JSON string or `Uint8Array`**. `ReadableStream` and `FormData` request bodies are passed through without interception.
- **Deny is post-flight**. See [Concepts → Deny flow](./concepts.md#deny-flow-at-l1--the-trick).
- **Streaming response body is `tee()`'d**. Slow downstream consumers can backpressure your parser.
- **Headers are not rewritten** — only the JSON body. If your auth setup encodes things in headers that need rewriting, do it elsewhere.

## Adding a new provider

Mirror the directory shape:

```
packages/provider-fetch/src/providers/<name>/
  types.ts       — wire types
  detect.ts      — URL matching
  normalize.ts   — request/response → NormalizedRequest/Response, extractToolCalls, extractUsage
  deny.ts        — applyDenyRewrites: rewrite tool-result-equivalent blocks by id
  stream.ts      — consumeStream: SSE parser → assembled response object
  index.ts       — export ProviderImpl
```

Then register in `intercept.ts`'s `BUILTIN_PROVIDERS` array. The provider registry is opaque (`ProviderImpl` types `unknown`), so nothing else needs to know.
