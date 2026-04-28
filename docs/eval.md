# Evaluation

`@harnesskit/eval` turns the event stream into something you can score and replay. Three pieces:

- `TraceRecorder` — interceptor that aggregates events per session
- Scorers — pure functions over a `Trace` returning a number
- `replayTrace` — re-emit a stored trace through a different bus (e.g., to test a stricter policy)

## Recording

```ts
import { TraceRecorder } from '@harnesskit/eval';

const recorder = new TraceRecorder();
bus.use(recorder);

// run your agent ...

const trace = recorder.getTrace(sessionId);
// or
const all = recorder.allTraces();
```

`Trace`:

```ts
interface Trace {
  readonly sessionId: string;
  readonly events: readonly AgentEvent[];
  readonly startedAt: number;
  readonly endedAt?: number;  // set when session.end is observed
}
```

`getTrace()` and `allTraces()` return **frozen snapshots** — mutating them doesn't affect the recorder, and vice versa. Call `recorder.clear()` to wipe state, or `recorder.clear(sessionId)` for a single session.

## Builtin scorers

```ts
import {
  toolCallCount,
  deniedRatio,
  totalTokens,
  turnCount,
  errorCount,
  durationMs,
  scoreTrace,
} from '@harnesskit/eval';

const scores = await scoreTrace(trace, [
  toolCallCount(),
  deniedRatio(),
  totalTokens(),
  turnCount(),
  errorCount(),
  durationMs(),
]);
// [
//   { scorerId: 'tool-call-count', value: 7 },
//   { scorerId: 'denied-ratio',    value: 0.14 },
//   { scorerId: 'total-tokens',    value: 4231 },
//   ...
// ]
```

| Scorer | Returns |
| --- | --- |
| `toolCallCount()` | count of `tool.call.requested` events |
| `deniedRatio()` | denied / requested (0 if no calls requested) |
| `totalTokens()` | input + output across every `usage` event |
| `turnCount()` | count of `turn.start` events (model API calls) |
| `errorCount()` | count of `error` events |
| `durationMs()` | wall-clock duration `endedAt - startedAt` (or last-event ts if no end) |

Each builtin takes an optional `id` arg if you want a custom name (e.g., to score the same trace with multiple thresholds). All scorers can be sync or async — `scoreTrace` awaits each one.

## Custom scorer

```ts
import type { Scorer, Trace } from '@harnesskit/eval';

export const longestToolName: Scorer = {
  id: 'longest-tool-name',
  description: 'character length of the longest tool name observed',
  score: (trace: Trace) => {
    let max = 0;
    for (const e of trace.events) {
      if (e.type === 'tool.call.requested') {
        max = Math.max(max, e.call.name.length);
      }
    }
    return max;
  },
};
```

## JSON round-trip

```ts
import { traceToJson, traceFromJson } from '@harnesskit/eval';

const json = traceToJson(trace);              // string
fs.writeFileSync('trace.json', json);

const loaded = traceFromJson(fs.readFileSync('trace.json', 'utf8'));
```

`traceFromJson` validates the basic shape (object with `sessionId` string + `events` array) and throws on malformed input. It does not validate every event — assume traces you accept are trusted.

## Replay through a different policy

The killer feature. Capture a trace under a loose policy, then replay it through a strict one to see what *would* have been blocked:

```ts
import { EventBus } from '@harnesskit/core';
import { allowTools, policyToInterceptor } from '@harnesskit/policy';
import { replayTrace } from '@harnesskit/eval';

const stricter = new EventBus();
stricter.use(policyToInterceptor(allowTools(['read_file'])));

const result = await replayTrace(loadedTrace, stricter);
console.log(`would block ${result.denials.length} call(s)`);
for (const d of result.denials) {
  if (d.event.type === 'tool.call.requested') {
    console.log(`  - ${d.event.call.name}: ${d.reason}`);
  }
}
```

`replayTrace` returns `{ trace, denials: [{ event, reason, policyId? }] }`. Useful for:

- **Pre-deploy policy testing** — run the new policy against last week's traces, count denials, eyeball the reasons.
- **Regression on policy changes** — assert that a known-good trace still passes.
- **What-if analysis** — "if we set `tokenBudget.output: 30_000`, how many sessions would have been cut off?"

Replay is **best-effort**: it re-fires the events but does not re-execute tool calls or model calls. Stateful policies that observe `usage` and `tool.call.resolved` events still get their state populated correctly because those events are in the trace.

## Combining with policies

A common production pattern: every interceptor on the bus, recorder included:

```ts
const recorder = new TraceRecorder();
const guard = policy().denyTools(['shell']).maxToolCalls(20).build();

bus.use(policyToInterceptor(guard));   // can deny
bus.use(recorder);                      // observes everything (including denies)
```

Order matters only when interceptors interact. The recorder is read-only on events, so its position is irrelevant.

## Limitations

- Traces grow linearly with session length. A long-running session retains every event in memory until `recorder.clear(sessionId)` is called.
- Scorers run sequentially, not in parallel. If you have expensive scorers, batch them with your own `Promise.all` outside `scoreTrace`.
