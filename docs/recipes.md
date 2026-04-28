# Recipes

Copy-paste patterns for common needs.

## Audit log to file

Stream every event to a JSONL file as it happens:

```ts
import fs from 'node:fs';
import { EventBus } from '@harnesskit/core';

const audit = fs.createWriteStream('audit.jsonl', { flags: 'a' });

const bus = new EventBus();
bus.use({
  name: 'audit',
  on: (e) => {
    audit.write(`${JSON.stringify(e)}\n`);
  },
  dispose: () => audit.end(),
});
```

JSONL means each line is one event, easy to tail with `jq` or pipe into Elasticsearch / Loki.

## Approval gateway with timeout

```ts
import { requireApproval } from '@harnesskit/policy';

const askWithTimeout = (prompt: string, timeoutMs = 30_000): Promise<boolean> =>
  Promise.race([
    askHumanSomehow(prompt),                                      // your impl
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

bus.use(policyToInterceptor(
  requireApproval({
    match: ['write_*', 'shell', 'fetch'],
    approver: (call) => askWithTimeout(`Run ${call.name} with ${JSON.stringify(call.input)}?`),
  }),
));
```

## Per-tenant policy

Different policies for different end-users in the same process:

```ts
import { EventBus } from '@harnesskit/core';
import { policy, policyToInterceptor } from '@harnesskit/policy';

const buildBus = (tenantId: string) => {
  const bus = new EventBus();
  const guard = policy()
    .tokenBudget({ output: tierLimits[tenantId].outputTokens })
    .denyTools(tierLimits[tenantId].deniedTools)
    .build(`tenant:${tenantId}`);
  bus.use(policyToInterceptor(guard));
  return bus;
};

// Each request gets its own bus + interceptor instance
app.post('/chat', async (req, res) => {
  const bus = buildBus(req.tenant.id);
  const dispose = installFetchInterceptor({ bus, getSessionId: () => req.id });
  try {
    // your agent code here
  } finally {
    dispose();
  }
});
```

`installFetchInterceptor` patches `globalThis.fetch`, so this is **only safe if requests are serialized** within a Node process. For concurrent requests use Vercel AI SDK adapter or Claude Agent SDK adapter (per-request) instead — they don't touch globals.

## Token budget alerts

Don't deny — just notify when you're close:

```ts
import type { AgentEvent, Interceptor } from '@harnesskit/core';

const tokenAlert = (limit: number, onAlert: (used: number) => void): Interceptor => {
  let used = 0;
  let alerted = false;
  return {
    name: 'token-alert',
    on(e: AgentEvent) {
      if (e.type !== 'usage') return;
      used += (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
      if (!alerted && used > limit * 0.8) {
        alerted = true;
        onAlert(used);
      }
    },
  };
};

bus.use(tokenAlert(100_000, (used) => sendSlackPing(`80% of budget used: ${used}`)));
```

## "What if" — replay against a candidate policy before deploying

```ts
import { TraceRecorder, replayTrace } from '@harnesskit/eval';
import { EventBus } from '@harnesskit/core';

// Step 1: in production, capture traces under the current policy
const recorder = new TraceRecorder();
bus.use(recorder);
// ... over the next week, harvest recorder.allTraces() into S3 / DB

// Step 2: in CI / a notebook, replay against the candidate policy
const candidateBus = new EventBus();
candidateBus.use(policyToInterceptor(theNewPolicy));

let totalDenials = 0;
for (const trace of harvestedTraces) {
  const r = await replayTrace(trace, candidateBus);
  totalDenials += r.denials.length;
}
console.log(`new policy would have denied ${totalDenials} calls across ${harvestedTraces.length} sessions`);
```

If the number is unexpectedly high, you have your answer before shipping.

## Detect a particular bad pattern

A custom interceptor that just observes:

```ts
const detectPiiLeak: Interceptor = {
  name: 'pii-detector',
  on(event) {
    if (event.type !== 'tool.call.resolved') return;
    const content = typeof event.result.content === 'string' ? event.result.content : '';
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(content)) {
      console.error('SSN-like pattern in tool result', event.ids);
      // emit your own metric / alert
    }
  },
};

bus.use(detectPiiLeak);
```

For prevention, do the same check in a `Policy.decide` instead — return `{ allow: false, reason: 'PII detected in input' }`.

## Combine L1 + L2

Both at once works fine:

```ts
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { withHarnesskit } from '@harnesskit/adapter-claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

const bus = new EventBus();
const dispose = installFetchInterceptor({ bus });   // L1 — wire-level

for await (const msg of query({
  prompt: '...',
  options: withHarnesskit(bus, {/* L2 — semantic-level */}),
})) { /* ... */ }

dispose();
```

You'll see both `source: 'l1'` and `source: 'l2'` events. Filter or merge based on what your downstream consumer needs.

## Production-ready bootstrap

The whole thing, packaged:

```ts
import { EventBus } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { policy, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

export interface HarnessOptions {
  tenantId: string;
  outputTokenBudget: number;
  deniedTools?: readonly string[];
  onTrace?: (trace: import('@harnesskit/eval').Trace) => Promise<void>;
}

export const setupHarness = (opts: HarnessOptions) => {
  const bus = new EventBus({
    onUnhandledError: (err) => console.error('[harnesskit interceptor error]', err),
  });

  bus.use(
    policyToInterceptor(
      policy()
        .tokenBudget({ output: opts.outputTokenBudget })
        .denyTools(opts.deniedTools ?? [])
        .build(`tenant:${opts.tenantId}`),
    ),
  );

  const recorder = new TraceRecorder();
  bus.use(recorder);

  const dispose = installFetchInterceptor({
    bus,
    getSessionId: () => `${opts.tenantId}:${Date.now()}`,
    redactHeaders: 'standard',
  });

  return {
    bus,
    async teardown() {
      dispose();
      if (opts.onTrace) {
        for (const t of recorder.allTraces()) await opts.onTrace(t);
      }
      await bus.dispose();
    },
  };
};
```

Use:

```ts
const h = setupHarness({
  tenantId: req.user.id,
  outputTokenBudget: 50_000,
  deniedTools: ['shell'],
  onTrace: async (t) => uploadToS3(t),
});

try {
  // agent code
} finally {
  await h.teardown();
}
```
