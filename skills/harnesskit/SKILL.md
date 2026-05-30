---
name: harnesskit
description: Build with HarnessKit, an embeddable TypeScript harness for LLM agents that unifies runtime guardrails, policy enforcement, tracing, evaluation, replay, provider interception, framework adapters, runner loops, SDK facade setup, and OpenTelemetry. Use when Codex needs to install or integrate @harnesskit packages, create a high-level harness with createHarness()/wrapTools(), add tool-deny or approval policies, redact PII, cap token/cost/reasoning budgets, record and score traces, replay evals, wire L1 provider-fetch interception for OpenAI/Anthropic/Gemini/OpenRouter/custom OpenAI-compatible hosts, use L2 adapters for Claude Agent SDK/OpenAI Agents/Vercel AI/LangGraph, debug AgentEvent streams, or run HarnessKit examples and demos.
---

# HarnessKit

## Overview

Use this skill to help another AI build, modify, or explain HarnessKit integrations. Keep the main workflow small, then load the relevant reference file for exact APIs, examples, and caveats.

HarnessKit is TypeScript, ESM-only, Node 20+, and centers on one `EventBus` that emits normalized `AgentEvent`s for policies, evals, traces, replay, and observability.

## Reference Map

Read only what the task needs:

- `references/project-overview.md`: package map, install snippets, examples, status, and end-to-end demos.
- `references/sdk.md`: high-level `createHarness()`, default tracing, fetch install, and pre-flight `wrapTools()`.
- `references/getting-started.md`: first install, first event, first policy, and minimal setup.
- `references/concepts.md`: `EventBus`, `AgentEvent`, content blocks, gateable events, L1 vs L2, and deny flow.
- `references/providers.md`: L1 `installFetchInterceptor`, provider matrix, OpenAI-compatible custom hosts, redaction, and limitations.
- `references/policies.md`: builtin policies, policy builder DSL, combinators, custom policies, and audit interceptors.
- `references/eval.md`: `TraceRecorder`, scorers, JSON round-trip, replay, and turning scores into policies.
- `references/adapters.md`: L2 adapters for Claude Agent SDK, OpenAI Agents SDK, Vercel AI SDK, and LangGraph.
- `references/runner.md`: `runAgent({...})` and streaming runner loops with policies and tracing wired in.
- `references/otel.md`: map `AgentEvent`s to OpenTelemetry spans.
- `references/recipes.md`: audit logging, approval gateway, budget caps, multi-tenant policies, eval gates, and deny recovery patterns.
- `references/roadmap.md`: current gaps, workarounds, and planned integrations.

For keyword search across the docs, use `rg "term" references/` from this skill directory.

## Task Workflow

1. Identify whether the user is asking for installation, policy design, provider interception, framework adapter wiring, evaluation/replay, runner usage, OTel export, or troubleshooting.
2. Load the matching reference file before giving exact code. For broad architecture questions, load `concepts.md` plus the domain-specific reference.
3. Prefer repo package APIs and examples over inventing wrappers. Imports should use `@harnesskit/*` packages and `.js` extensions for local TypeScript ESM imports.
4. When editing a HarnessKit repo, inspect the existing package and tests first. Add tests near the touched package when behavior changes.
5. For real provider examples, call out required environment variables and whether an example can run with mocks.

## Common Starting Points

### Add L1 Guardrails to Any SDK

Load `getting-started.md`, `providers.md`, and usually `policies.md`.

Typical shape:

```ts
import { EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const bus = new EventBus();
bus.use(policyToInterceptor(denyTools(['shell'])));
installFetchInterceptor({ bus });
```

Remember: L1 denial is post-flight and rewrites the next tool result into an error. For hard pre-execution prevention, prefer an L2 adapter or sandbox.

### Use the High-Level SDK Facade

Load `sdk.md`, `policies.md`, and optionally `runner.md`.

Typical shape:

```ts
import { denyTools } from '@harnesskit/policy';
import { createHarness } from '@harnesskit/sdk';

const harness = createHarness({
  policies: [denyTools(['shell'])],
  fetch: true,
});

const tools = harness.wrapTools({
  shell: {
    execute: async (args) => runShell(String(args.cmd)),
  },
});
```

Use this when the user wants low-boilerplate setup, default trace capture, or host-side pre-flight tool gating.

### Design Policies

Load `policies.md`.

Use builtins first: `allowTools`, `denyTools`, `requireApproval`, `tokenBudget`, `maxToolCalls`, `argRegex`, `hostnameAllowlist`, `piiScan`, `costBudget`, `reasoningBudget`, `outputContentRegex`, and `outputPiiScan`. Combine them with `allOf`, `anyOf`, or the fluent builder when the user needs layered rules.

### Record, Score, and Replay

Load `eval.md` and optionally `recipes.md`.

Use `TraceRecorder` for capture, builtin scorers for common checks, JSON serialization for artifacts, and replay when comparing a trace against stricter policies or new scorers.

### Wire Framework Adapters

Load `adapters.md` plus `concepts.md`.

Use L2 adapters when the host framework can enforce tool decisions before execution or expose richer lifecycle events like approvals, subagents, and context compaction. Use L1 + L2 together only when wire visibility and framework semantics are both useful.

### Use the Runner

Load `runner.md`.

Use `@harnesskit/runner` for compact OpenAI-compatible agent loops where policies, tool execution, tracing, and stream handling should be wired without adopting a larger framework.

## Verification

For code changes inside a HarnessKit repo, prefer:

```bash
pnpm test
pnpm lint
pnpm typecheck
```

If the repo exposes narrower package scripts, run the smallest relevant command first, then broaden if the change touches shared contracts.
