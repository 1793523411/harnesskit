# SDK facade

`@harnesskit/sdk` is the high-level entry point for teams that want HarnessKit's default wiring without giving up the lower-level packages.

It composes:

- `EventBus` from `@harnesskit/core`
- policies via `policyToInterceptor`
- `TraceRecorder` from `@harnesskit/eval`
- optional L1 fetch interception from `@harnesskit/provider-fetch`
- pre-flight host tool gating via `wrapTool` / `wrapTools`

## Install

```bash
pnpm add @harnesskit/sdk @harnesskit/policy
```

Add `@harnesskit/runner` if you want the minimal OpenAI-compatible loop.

## 30-second setup

```ts
import { denyTools, tokenBudget } from '@harnesskit/policy';
import { createHarness } from '@harnesskit/sdk';

const harness = createHarness({
  policies: [denyTools(['shell']), tokenBudget({ output: 5_000 })],
  fetch: {
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },
  },
});

// Any supported provider request in this process is now observed by L1.
// Every event is collected in `harness.events`; a TraceRecorder is attached by default.
```

If you do not want global fetch interception on construction, omit `fetch` and call it later:

```ts
const disposeFetch = harness.installFetch();
disposeFetch();
```

Fetch interception installed through the facade uses the facade's stable `sessionId` by default, so `harness.getTrace()` includes SDK session events and L1 model-call events together. Pass `getSessionId` to `installFetch()` if you need custom session routing.

## Pre-flight tool gating

L1 interception observes model traffic and can rewrite denied tool results on the next turn, but it cannot stop a host runtime from executing a tool that it already received. `wrapTools` gives you a host-side tool boundary:

```ts
import { denyTools } from '@harnesskit/policy';
import { createHarness } from '@harnesskit/sdk';

const harness = createHarness({ policies: [denyTools(['shell'])] });

const tools = harness.wrapTools({
  shell: {
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    },
    execute: async ({ cmd }) => runShell(String(cmd)),
  },
});

await tools.shell.execute({ cmd: 'rm -rf /' });
// throws HarnessToolDeniedError before `runShell` is called
```

For allowed calls, the wrapper emits:

1. `tool.call.requested`
2. `tool.call.resolved`

For denied calls, it emits:

1. `tool.call.requested`
2. `tool.call.denied`

If the underlying executor throws, the wrapper emits `tool.call.resolved` with `isError: true`, emits an `error` event, then rethrows the original error.

## Sessions and traces

The facade creates a stable SDK session id:

```ts
await harness.startSession({ tenant: 'demo' });
// run your agent
await harness.endSession();

console.log(harness.events);
console.log(harness.getTrace());
console.log(harness.allTraces());
await harness.dispose();
```

`harness.dispose()` restores any fetch interceptors installed through the facade. It also disposes the bus when the bus was created by `createHarness`; caller-owned buses are left alive by default.

## Bring your own bus

```ts
const harness = createHarness({
  bus: existingBus,
  disposeBus: false,
  policies: [denyTools(['shell'])],
});
```

This is useful when multiple framework adapters share the same bus, or when your application already has an `EventBus` lifecycle.

## Real-model demo

```bash
VOLCENGINE_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk
# or
OPENAI_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk
```

The demo asks the model to try a blocked `shell` tool, then recover with `list_files`. The SDK wrapper prevents the `shell` executor from running, while the shared bus still records the denial and trace.
