# harnesskit

> Embeddable constraint + evaluation harness for LLM agents. Drop into any agent runtime, get a single event stream that lets you both **enforce** and **observe** in one pass.

```ts
import { EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const bus = new EventBus();
bus.use(policyToInterceptor(denyTools(['shell'])));
installFetchInterceptor({ bus });

// That's it. Any code in this process that calls Anthropic / OpenAI / OpenRouter
// is now constrained — model still produces the tool call, but the next turn
// sees an "[harnesskit denied] ..." tool result and adapts.
```

## Why

Two things every agent runtime needs:

1. **Constrain** the agent — block tools, require approval, cap tokens, redact secrets.
2. **Evaluate** the agent — record traces, score behavior, replay against different policies.

These two are usually shipped as separate products, but they share the same instrumentation surface. Every "is this tool call allowed?" decision is also an eval signal. Every eval scorer (e.g. "did it leak PII?") can be lifted into a runtime guardrail. harnesskit ships them as one event bus.

## Architecture

Three integration layers, all optional, all emit the same `AgentEvent` shape so downstream consumers (policy / eval / trace) can't tell which layer produced an event:

| Layer | What it is | Best for |
| --- | --- | --- |
| **L1** | `globalThis.fetch` patch — auto-detects Anthropic Messages, OpenAI Chat, OpenAI Responses, OpenRouter | Any agent built on standard SDKs — no framework lock-in |
| **L2** | Per-framework adapter (Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK) | Richer semantics — subagents, approvals, session lifecycle |
| **L1 + L2** | Both at once | Wire-level visibility plus framework-level metadata, dedupe via `turnId` |

## Packages

| Package | Purpose |
| --- | --- |
| [`@harnesskit/core`](./packages/core) | Event bus, `AgentEvent` types, `Interceptor`/`Policy` interfaces |
| [`@harnesskit/policy`](./packages/policy) | 11 builtin policies (allowTools/denyTools/requireApproval/tokenBudget/maxToolCalls/argRegex/hostnameAllowlist/piiScan/costBudget/reasoningBudget + outputContentRegex/outputPiiScan audit interceptors), `allOf`/`anyOf` combinators, fluent builder |
| [`@harnesskit/eval`](./packages/eval) | `TraceRecorder`, 6 builtin scorers, JSON serialization, replay |
| [`@harnesskit/provider-fetch`](./packages/provider-fetch) | L1 fetch interceptor — Anthropic, OpenAI Chat, OpenAI Responses, OpenRouter, **Gemini** |
| [`@harnesskit/runner`](./packages/runner) | `runAgent({...})` — minimal OpenAI-Compat agent loop with policies + tracing wired |
| [`@harnesskit/otel`](./packages/otel) | OpenTelemetry exporter mapping AgentEvents → spans |
| [`@harnesskit/adapter-claude-agent-sdk`](./packages/adapter-claude-agent-sdk) | L2 adapter for `@anthropic-ai/claude-agent-sdk` |
| [`@harnesskit/adapter-openai-agents`](./packages/adapter-openai-agents) | L2 adapter for `@openai/agents` |
| [`@harnesskit/adapter-vercel-ai`](./packages/adapter-vercel-ai) | L2 adapter for `ai` (Vercel AI SDK) |
| [`apps/trace-viewer`](./apps/trace-viewer) | Standalone single-file HTML viewer for captured traces |

## Install

```bash
pnpm add @harnesskit/core @harnesskit/policy @harnesskit/provider-fetch
# Add `@harnesskit/eval` if you want trace recording.
# Add the matching `@harnesskit/adapter-*` if you want L2 semantics.
```

Requires Node 20+, ESM-only.

## Documentation

- [Getting started](./docs/getting-started.md) — install, first event, first policy
- [Concepts](./docs/concepts.md) — architecture, `AgentEvent`, `EventBus`, deny semantics
- [Providers (L1)](./docs/providers.md) — provider matrix, custom hosts, header redaction
- [Policies](./docs/policies.md) — every builtin, the builder DSL, writing your own
- [Evaluation](./docs/eval.md) — recording, scoring, replay, JSON
- [Framework adapters (L2)](./docs/adapters.md) — Claude Agent SDK, OpenAI Agents, Vercel AI
- [Recipes](./docs/recipes.md) — audit log, approval gateway, budget cap, multi-policy tenant

## Examples

Runnable end-to-end demos in [`examples/`](./examples/src):

```bash
pnpm --filter @harnesskit/examples quickstart          # Anthropic + denyTools
pnpm --filter @harnesskit/examples openai-quickstart   # same code, OpenAI Chat Completions
pnpm --filter @harnesskit/examples policy-and-eval     # full policy + scorer pipeline
pnpm --filter @harnesskit/examples replay-eval         # capture trace, replay through stricter policy
```

All four mock examples run without API keys. There are also real-API integration suites gated on env vars:

```bash
VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples integration-volcengine    # 7 scenarios on Volcengine
VOLCENGINE_API_KEY=… DEEPSEEK_API_KEY=… MINIMAX_API_KEY=… OPENAI_API_KEY=… \
  pnpm --filter @harnesskit/examples integration-real-api                          # 4-provider parity + edge cases
VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase                   # before/after demo (see below)
```

### Showcase: dangerous-tool recovery

`pnpm showcase` runs the same prompt twice — once **without** harnesskit, once with `denyTools(['shell'])` — and prints a side-by-side. A representative run on `deepseek-v3-2-251201` with the prompt _"List log files in /var/log AND show their sizes and last-modified times"_:

```
Baseline   tools used: [list_files, shell, shell, shell]  denied: 0
Guarded    tools used: [shell, list_files, shell, list_files]  denied: 2

✓ harness denied + rewrote 2 shell attempts
✓ model recovered to list_files each time, with no human intervention
```

Same model, same prompt, different config. The agent's dangerous attempts get caught at the wire layer, the model sees a tool-result error, and adapts to the safer alternative on its own. Reproducible end-to-end.

### More before/after showcases

Run `pnpm --filter @harnesskit/examples showcases` to run all five sequentially. Sample real-model outputs:

| Showcase | Baseline | Guarded |
| --- | --- | --- |
| `showcase-tokens` (`tokenBudget`) | 10 weather calls | 7 calls + **5 denials** when budget exceeded |
| `showcase-args` (`argRegex`) | shell × 10 unrestricted | shell × 10, **4 destructive cmds blocked** |
| `showcase-hostname` (`hostnameAllowlist`) | 3 fetches across the web, full answer | 10 fetches, **8 non-Wikipedia URLs blocked** |
| `showcase-pii` (`piiScan`) | webhook posts email + SSN | **1 PII leak blocked** → model strips PII and retries successfully |

Each showcase is a self-contained `.ts` file you can read, modify, and re-run. See [`examples/src/showcase-*.ts`](./examples/src).

## Status

`v0.0.0` — internal API stable, public release pending. 70+ unit tests, lint clean, four mock examples plus a real-API integration suite covering Volcengine / DeepSeek / Doubao / MiniMax / OpenAI gpt-5 series, including reasoning-model `reasoning_content` normalization, 4-provider customHosts, multi-turn tool chains, and concurrent sessions. OpenAI-compatible providers (Volcengine, Groq, Together, any LiteLLM proxy) work via `customHosts.openai`.

## License

MIT (after first release).
