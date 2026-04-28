# Documentation

Pick the order that fits your goal:

- **Just want to run something** → [Getting started](./getting-started.md)
- **Want the mental model first** → [Concepts](./concepts.md)
- **Already know what you want, looking for reference** → [Policies](./policies.md), [Eval](./eval.md), [Providers](./providers.md), [Adapters](./adapters.md)
- **Looking for a pattern** → [Recipes](./recipes.md)

| Guide | Reads in | What you'll learn |
| --- | --- | --- |
| [Getting started](./getting-started.md) | 5 min | Install + a working interceptor + your first policy |
| [Concepts](./concepts.md) | 10 min | The event bus, `AgentEvent` shape, L1 vs L2, deny flow |
| [Providers (L1)](./providers.md) | 10 min | What each provider covers, custom hosts, redaction |
| [Policies](./policies.md) | 15 min | Every builtin, the fluent builder, custom policies |
| [Evaluation](./eval.md) | 10 min | `TraceRecorder`, scorers, replay, JSON round-trip |
| [Framework adapters (L2)](./adapters.md) | 15 min | Claude Agent SDK, OpenAI Agents, Vercel AI integration |
| [Recipes](./recipes.md) | 10 min | Common patterns: audit, approval, budget, multi-tenant |

## Working examples

Every example below is runnable: see [`examples/src/`](../examples/src) and run them with `pnpm --filter @harnesskit/examples <script>`.

## Conventions in these docs

- All code is TypeScript, ESM, `Node 20+`.
- Imports use `.js` extensions (TypeScript ESM convention) — your TS config should have `"moduleResolution": "Bundler"` or `"NodeNext"`.
- The phrase "the bus" always means an `EventBus` from `@harnesskit/core`.
- Event types are written as `tool.call.requested` (the `type` field on `AgentEvent`).
