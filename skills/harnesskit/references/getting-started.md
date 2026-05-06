# Getting started

Five minutes from `pnpm add` to a working policy that blocks shell commands across any agent runtime calling Anthropic.

## 1. Install

```bash
pnpm add @harnesskit/core @harnesskit/policy @harnesskit/provider-fetch
```

Requires Node 20+. ESM-only.

## 2. Build a bus and install the interceptor

```ts
import { EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const bus = new EventBus();
const dispose = installFetchInterceptor({ bus });

// `dispose()` later restores the original fetch.
```

`installFetchInterceptor` patches `globalThis.fetch`. Any subsequent code in this process that hits `api.anthropic.com/v1/messages`, `api.openai.com/v1/chat/completions`, `api.openai.com/v1/responses`, or `openrouter.ai/api/v1/chat/completions` is now visible to the bus.

## 3. Add a logger to see what flows through

```ts
bus.use({
  name: 'logger',
  on: (e) => console.log(`[${e.source}] ${e.type}`, e.ids),
});
```

Run any agent code that calls Anthropic — you'll see:

```
[l1] turn.start         { sessionId: 'sess_…', turnId: 'turn_…' }
[l1] turn.end           { sessionId: 'sess_…', turnId: 'turn_…' }
[l1] usage              { sessionId: 'sess_…', turnId: 'turn_…' }
[l1] tool.call.requested { sessionId: 'sess_…', turnId: 'turn_…', callId: 'toolu_…' }
```

## 4. Block a tool

```ts
import { denyTools, policyToInterceptor } from '@harnesskit/policy';

bus.use(policyToInterceptor(denyTools(['shell'])));
```

When the model emits a `tool_use` block named `shell`, the bus marks the call as denied. On the next request the host SDK sends, harnesskit rewrites the corresponding `tool_result` to `{ is_error: true, content: '[harnesskit denied] tool "shell" is denied' }`. The model sees the error and adapts.

## 5. Compose more policies

```ts
import { policy, policyToInterceptor } from '@harnesskit/policy';

const guard = policy()
  .denyTools(['shell', 'exec_*'])
  .allowTools(['read_*', '*_file'])
  .tokenBudget({ total: 100_000 })
  .maxToolCalls(20)
  .build('production');

bus.use(policyToInterceptor(guard));
```

Read the full builtin catalog in [Policies](./policies.md).

## 6. Record everything

```ts
import { TraceRecorder, scoreTrace, toolCallCount, deniedRatio } from '@harnesskit/eval';

const recorder = new TraceRecorder();
bus.use(recorder);

// ... run your agent ...

const trace = recorder.allTraces()[0];
const scores = await scoreTrace(trace, [toolCallCount(), deniedRatio()]);
console.log(scores);  // [{ scorerId: 'tool-call-count', value: 7 }, ...]
```

## 7. Whole thing together

```ts
import { EventBus } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { policy, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const bus = new EventBus();
const recorder = new TraceRecorder();

bus.use(recorder);
bus.use(
  policyToInterceptor(
    policy()
      .denyTools(['shell'])
      .tokenBudget({ output: 50_000 })
      .build()
  )
);

const dispose = installFetchInterceptor({ bus });

// Your existing agent code goes here, unchanged.

// When done:
dispose();
console.log(recorder.allTraces());
```

## Where next

- [Concepts](./concepts.md) — what `AgentEvent` is, what L1/L2 mean, how `deny()` actually works
- [Recipes](./recipes.md) — copy-paste patterns for common needs
