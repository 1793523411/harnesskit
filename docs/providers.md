# Providers (L1)

`@harnesskit/provider-fetch` patches `globalThis.fetch` to recognize four model APIs out of the box. All other URLs pass through untouched.

## Provider matrix

| Provider tag | Endpoint match | Wire format | Streaming | Deny rewrite target |
| --- | --- | --- | --- | --- |
| `anthropic` | `api.anthropic.com/v1/messages` | Anthropic Messages | SSE with named events | `tool_result` block in user message |
| `openai` | `api.openai.com/v1/chat/completions` | OpenAI Chat Completions | SSE data lines (+ `[DONE]`) | `role: 'tool'` message |
| `openai-responses` | `api.openai.com/v1/responses` | OpenAI Responses API | SSE with named events (`response.*`) | `function_call_output` item |
| `openrouter` | `openrouter.ai/api/v1/chat/completions` | OpenAI-compatible | Same as `openai` | Same as `openai` |

All four are tested for both **non-streaming** and **streaming** paths, including deny-rewrite across requests.

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

After rewriting, the entry is removed from the deny store — re-emission of the same `tool_use_id` (rare but possible) won't re-deny.

## Custom hosts (proxies, gateways)

Many teams run a proxy in front of the real API:

```ts
installFetchInterceptor({
  bus,
  customHosts: {
    anthropic: ['llm-gateway.internal'],
    openai: ['my-litellm.example.com'],
  },
});
```

Now `https://llm-gateway.internal/v1/messages` is treated as Anthropic. Default hosts are still recognized.

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
