# Runner — 30-line production agent loops

`@harnesskit/runner` is the "I want a working agent in 30 lines" entry point. It implements a minimal OpenAI-compatible chat-completions loop using `globalThis.fetch` — which means the L1 fetch interceptor catches it automatically, so policies / recorders / OTel / everything else just works.

## Install

```bash
pnpm add @harnesskit/runner @harnesskit/policy
```

## Usage

```ts
import { runAgent } from '@harnesskit/runner';
import { denyTools, tokenBudget } from '@harnesskit/policy';

const result = await runAgent({
  // Model
  baseUrl: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',

  // Conversation
  systemPrompt: 'You are helpful.',
  prompt: 'Tell me about /etc/hosts',

  // Tools — each `execute` runs after the harness allows the call
  tools: {
    read_file: {
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async (args) => fs.readFileSync(args.path as string, 'utf8'),
    },
  },

  // Harness — these are added to a fresh internal bus
  policies: [denyTools(['shell']), tokenBudget({ output: 5_000 })],
  maxRounds: 10,
});

console.log(result.text);          // final assistant text
console.log(result.toolCalls);     // [{name, input, result}]
console.log(result.events);        // every AgentEvent the bus saw
console.log(result.trace);         // captured Trace (recorder default-on)
```

## API

```ts
runAgent({
  baseUrl,            // OpenAI-compatible endpoint root, no trailing /chat/completions
  apiKey,             // sent as Bearer
  model,              // model id
  prompt,             // user message
  systemPrompt?,      // optional system prompt
  tools?,             // { [name]: { description?, parameters?, execute } }

  bus?,               // bring your own EventBus (advanced)
  policies?,          // Policy[] — only used if bus is omitted
  interceptors?,      // Interceptor[] — only used if bus is omitted
  recorder?,          // false | true | TraceRecorder. Default: true
  customHosts?,       // forwarded to installFetchInterceptor
  maxRounds?,         // default 10

  onAssistantMessage?, // (msg) => void — called per model reply
}): Promise<{
  text,               // final assistant content
  toolCalls,          // [{id, name, input, result, error?}]
  events,             // AgentEvent[]
  trace?,             // Trace if recorder was attached
  rounds,             // number of model API calls made
  messages,           // full transcript including tool messages
}>
```

## What it does internally

1. Build messages array (system + user).
2. Install the L1 fetch interceptor on the local bus.
3. Loop:
   - POST `${baseUrl}/chat/completions` with current messages + tools.
   - If model returns a final text → return.
   - If model returns `tool_calls` → for each, execute and append result.
4. Dispose interceptor and return the result.

The interceptor catches every model API call (so policies/recorders observe everything). When a policy denies a tool call, the deny is recorded; on the next round, the tool message gets rewritten transparently to a denial.

## Bring your own bus

For multi-tenant or shared-bus setups, pass an existing `EventBus` and skip the `policies`/`interceptors`/`recorder` shorthand options:

```ts
const bus = setupHarness(req.tenant.id);
const result = await runAgent({ bus, /* … */ });
```

`runAgent` will not register additional policies on a bus you provide — assumed already configured.

## When to use this vs roll-your-own

Use `runAgent` when:
- You want `globalThis.fetch` interception (works for any host).
- The OpenAI Chat Completions wire format covers your provider (most do).
- You don't need streaming output to your end-user — streaming is **not** exposed via runAgent in v0; use `installFetchInterceptor` directly with your own loop if you need it.

Roll your own loop when:
- You need streaming responses surfaced to the caller.
- You're using a provider with a different wire format that we don't normalize for runAgent (Anthropic Messages, Gemini generateContent, etc.). Note: those are still observed by L1 interception — but runAgent's loop only speaks Chat Completions today.
