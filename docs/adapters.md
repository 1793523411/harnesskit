# Framework adapters (L2)

Four adapters ship today. Each takes an `EventBus` plus the framework's options object (or its hook emitter / callback handler) and emits the same `AgentEvent` shape as L1, plus framework-specific enrichment events that L1 can't see.

| Adapter | Host package | Enriched events beyond L1 |
| --- | --- | --- |
| `@harnesskit/adapter-claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | `subagent.spawn`/`return`, `approval.requested`/`resolved`, `context.compacted` |
| `@harnesskit/adapter-openai-agents` | `@openai/agents` | `subagent.spawn` (handoffs) |
| `@harnesskit/adapter-vercel-ai` | `ai` (Vercel AI SDK) | `session.start`/`end`, full `tool.call.resolved` with content |
| `@harnesskit/adapter-langgraph` | `@langchain/core` (LangChain.js / LangGraph) | `tool.call.resolved` with content + `error` events from `handleLLMError` / `handleToolError` |

All adapters are **opt-in**: install the corresponding `@harnesskit/adapter-*` package and the `peerDependency` only matters at the call site.

## Claude Agent SDK

Wrap the SDK options object before passing it to `query()`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { EventBus } from '@harnesskit/core';
import { withHarnesskit } from '@harnesskit/adapter-claude-agent-sdk';

const bus = new EventBus();

const messages = query({
  prompt: 'list files in /tmp',
  options: withHarnesskit(bus, {
    // your existing SDK options ...
    hooks: { /* your hooks ... */ },
    canUseTool: yourApprovalFn,
  }),
});

for await (const msg of messages) { /* ... */ }
```

What `withHarnesskit` does:

1. **Appends observer hooks** to `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `PreCompact`, `SubagentStart`, `SubagentStop`. Your existing hooks still run — ours run alongside.
2. **Wraps `canUseTool`**. Every approval question fires `approval.requested` → calls your original `canUseTool` (if any) → fires `approval.resolved`.
3. **PreToolUse can deny.** When the bus denies a `tool.call.requested`, the wrapper returns `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '...' } }` — the SDK then refuses to run the tool.

Unlike L1, this is **pre-flight prevention** — the tool literally never runs.

## OpenAI Agents SDK

`Runner` extends `RunHooks` (an EventEmitter), so you pass the runner instance directly as `runHooks`:

```ts
import { Agent, Runner } from '@openai/agents';
import { EventBus } from '@harnesskit/core';
import { attachOpenAIAgentsAdapter } from '@harnesskit/adapter-openai-agents';

const bus = new EventBus();
const agent = new Agent({ /* ... */ });

const runner = new Runner();
const dispose = attachOpenAIAgentsAdapter({ bus, runHooks: runner });

const result = await runner.run(agent, 'do the thing');
console.log(result.finalOutput);

dispose();
```

What it captures:

- `agent_start` → `session.start` (first time only — handoffs reuse the session)
- `agent_handoff` → `subagent.spawn`
- `agent_tool_start` → `tool.call.requested`
- `agent_tool_end` → `tool.call.resolved`

Note: the OpenAI Agents SDK's hook events are observe-only — the `RunHooks` emitter doesn't support cancellation. Tool denial in this adapter is **not enforced**; if you need real prevention, either use a guardrail at the SDK level or add L1 fetch interception alongside (which catches the underlying Responses API call).

## Vercel AI SDK

Wrap the options to `streamText` / `generateText`:

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { EventBus } from '@harnesskit/core';
import { withHarnesskit } from '@harnesskit/adapter-vercel-ai';

const bus = new EventBus();

const result = await generateText(
  withHarnesskit(bus, {
    model: openai('gpt-4o'),
    tools: {
      shell: { /* your tool definition */ },
    },
    messages: [...],
  })
);
```

What it does:

1. **Wraps every `tools[name].execute`** function with a deny gate. Before running, it calls `bus.emit({ type: 'tool.call.requested', ... })`. If denied, it throws an error — the AI SDK catches that error and reports a failed tool result, which the model sees and adapts to.
2. **Wraps `onStepFinish`** to emit `turn.start`/`turn.end`/`usage`/`tool.call.resolved` (with content from `step.toolResults`).
3. **Wraps `onFinish`** to emit `session.end`.

The first `onStepFinish` call also emits `session.start`. Your existing `onStepFinish`/`onFinish` callbacks still fire.

Unlike L1 (which sees the wire) or Claude Agent SDK adapter (which uses `permissionDecision`), the Vercel adapter's deny path **prevents tool execution** by throwing inside `execute` — the model sees a thrown-error result, not silence.

## LangChain.js / LangGraph

`harnesskitCallbacks({ bus })` returns a duck-typed `BaseCallbackHandler`-shaped object. Pass it via `{ callbacks: [...] }` to any LangChain Runnable (chain, agent, StateGraph node, `ChatModel.invoke`, tool `.invoke`):

```ts
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { EventBus } from '@harnesskit/core';
import { harnesskitCallbacks } from '@harnesskit/adapter-langgraph';
import * as z from 'zod';

const bus = new EventBus();
const cb = harnesskitCallbacks({ bus });

const getWeather = tool(async ({ city }) => `22°C in ${city}`, {
  name: 'get_weather',
  description: 'Look up the weather.',
  schema: z.object({ city: z.string() }),
});

const llm = new ChatOpenAI({ model: 'gpt-4o-mini' }).bindTools([getWeather]);

// One callback config covers both LLM turns and tool invocations.
const reply = await llm.invoke(messages, { callbacks: [cb] });
for (const tc of reply.tool_calls ?? []) {
  await getWeather.invoke({ ...tc, type: 'tool_call' as const }, { callbacks: [cb] });
}
```

What it captures:

- `handleLLMStart`  → `turn.start`
- `handleLLMEnd`    → `turn.end` + `usage` (when `output.llmOutput.tokenUsage` is present)
- `handleLLMError`  → `error` (with `stage: 'turn.end'`)
- `handleToolStart` → `tool.call.requested` (LangChain v1 passes the tool name as the `runName` arg, not on the tool object — the adapter handles both shapes)
- `handleToolEnd`   → `tool.call.resolved` with content
- `handleToolError` → `tool.call.resolved` with `isError: true`

Tool deny via this path is **best-effort** — LangChain executes the tool regardless of what `handleToolStart` returns, so a `bus.deny()` will not stop it. If you need hard prevention, either (a) wrap the tool's `func` yourself and check the bus before running, or (b) layer L1 fetch interception alongside, which catches the underlying provider call and rewrites the next-turn tool result so the model adapts.

## When to use which

```
Just want any agent to be observable + constrained, no framework lock-in?
  → L1 (provider-fetch) only.

You're using one of the three frameworks above and want subagent / approval semantics?
  → Add the matching L2 adapter on top of L1.

Hard prevention required (tool MUST NOT run on deny)?
  → L2 adapter. L1 alone is post-flight.
```

## Cross-adapter consistency

All four adapters produce the **same** `AgentEvent` shape. A `tool.call.requested` from the Claude adapter is indistinguishable (modulo `source: 'l2'` and any framework-specific `meta`) from one from the Vercel adapter. This means the same policy / scorer / recorder code works regardless of which framework the agent runs on.

## Adapter combinations

L1 + any L2 adapter is fine. Events get tagged `source: 'l1'` or `source: 'l2'`, but otherwise look the same. If you want to dedupe, key by `(turnId, callId)` — both layers will produce events with matching IDs because the call IDs come from the wire. Filter or merge however your downstream tooling expects.

## Writing your own adapter

If your framework isn't covered:

1. Find its hook surface (callbacks, EventEmitter, etc.).
2. On every relevant lifecycle event, call `bus.emit({ type: '<type>', source: 'l2', ids: { sessionId, turnId, callId? }, ... })`.
3. For deny semantics, check `bus.emit().denied` on `tool.call.requested` and translate to the framework's cancellation API (throw, return false, etc.).
4. Return a disposer that unsubscribes.

Pattern reference: read [`packages/adapter-openai-agents/src/index.ts`](../packages/adapter-openai-agents/src/index.ts) — it's the simplest of the four. For a callback-handler-style adapter (no EventEmitter / no options-wrap), see [`packages/adapter-langgraph/src/index.ts`](../packages/adapter-langgraph/src/index.ts).
