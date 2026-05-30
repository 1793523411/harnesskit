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
```

## Pre-flight tool gating

L1 interception observes model traffic and can rewrite denied tool results on the next turn, but it cannot stop a host runtime from executing a tool that it already received. `wrapTools` gives you a host-side tool boundary:

```ts
const tools = harness.wrapTools({
  shell: {
    execute: async ({ cmd }) => runShell(String(cmd)),
  },
});

await tools.shell.execute({ cmd: 'rm -rf /' });
// throws HarnessToolDeniedError before `runShell` is called
```

For allowed calls, the wrapper emits `tool.call.requested` then `tool.call.resolved`. For denied calls, it emits `tool.call.requested` then `tool.call.denied`.

## Real-model demo

```bash
VOLCENGINE_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk
# or
OPENAI_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk
```
