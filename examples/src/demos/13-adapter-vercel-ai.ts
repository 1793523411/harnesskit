// L2 adapter demo: Vercel AI SDK
//
// `withHarnesskit(bus, opts)` wraps `generateText` / `streamText` options:
//   - every tool's `execute` is wrapped to emit tool.call.requested (and
//     throw if the bus denies it)
//   - `onStepFinish` is wrapped to emit turn.start / turn.end / usage /
//     tool.call.resolved
//   - `onFinish` emits session.end
//
// We pair the L2 adapter with an L1 fetch interceptor so events from both
// layers land in the same bus. The denyTools policy fires at L2 (before
// the model's tool call is dispatched), proving you can constrain agents
// without changing your runtime code.
//
// Run: OPENAI_API_KEY=… pnpm --filter @harnesskit/examples demo:adapter-vercel-ai

import { openai } from '@ai-sdk/openai';
import { withHarnesskit } from '@harnesskit/adapter-vercel-ai';
import { type AgentEvent, EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor, tokenBudget } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { type ToolSet, generateText, stepCountIs, tool } from 'ai';
import * as z from 'zod';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`set ${k}`);
    process.exit(1);
  }
  return v;
};

const main = async (): Promise<void> => {
  const apiKey = need('OPENAI_API_KEY');
  // The Vercel `@ai-sdk/openai` provider reads its key from this env var.
  process.env.OPENAI_API_KEY = apiKey;
  const model = process.env.OPENAI_MINI_MODEL ?? 'gpt-4o-mini';

  console.log('=== Vercel AI SDK + harnesskit (L1 fetch + L2 adapter) ===\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({
    name: 'tap',
    on: (e) => {
      events.push(e);
    },
  });

  // Policy: ban `delete_file`, cap output to 800 tokens
  bus.use(policyToInterceptor(denyTools(['delete_file'])));
  bus.use(policyToInterceptor(tokenBudget({ output: 800 })));

  // L1: capture wire-level events (turn.start, turn.end, tool.call.requested, …)
  const dispose = installFetchInterceptor({ bus });

  // L2: wrap the Vercel AI options. Same options object — adapter only adds
  // wrappers around tool.execute / onStepFinish / onFinish. The adapter's
  // ToolLike type is intentionally loose (so it works with any provider's
  // tool factory) — we cast back to ToolSet at the generateText boundary.
  const tools: ToolSet = {
    list_files: tool({
      description: 'List files at a path. Read-only.',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => JSON.stringify(['readme.md', 'package.json', 'src/']),
    }),
    delete_file: tool({
      description: 'Permanently delete a file.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => `deleted ${path}`,
    }),
  };

  const wrapped = withHarnesskit(
    { bus },
    {
      tools: tools as unknown as Record<string, never>,
      onStepFinish: () => {},
      onFinish: () => {},
    },
  );

  type StepCb = NonNullable<Parameters<typeof generateText>[0]['onStepFinish']>;
  type FinishCb = NonNullable<Parameters<typeof generateText>[0]['onFinish']>;
  const result = await generateText({
    model: openai(model),
    tools: wrapped.tools as unknown as ToolSet,
    onStepFinish: wrapped.onStepFinish as unknown as StepCb,
    onFinish: wrapped.onFinish as unknown as FinishCb,
    stopWhen: stepCountIs(4),
    system:
      'You manage files. Use list_files freely. delete_file is dangerous — only when explicitly told.',
    prompt: 'Show me what is at the project root, then delete package.json.',
  });

  dispose();

  // Summary
  const layers: Record<string, number> = {};
  for (const e of events) {
    const key = `${e.source}:${e.type}`;
    layers[key] = (layers[key] ?? 0) + 1;
  }
  console.log(`final text: ${result.text.slice(0, 200) || '(empty)'}\n`);
  console.log('event counts by source:type');
  for (const [k, v] of Object.entries(layers).sort()) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  const denied = events.filter((e) => e.type === 'tool.call.denied');
  console.log(`\ndenied tool calls: ${denied.length}`);
  for (const e of denied) {
    if (e.type === 'tool.call.denied') console.log(`  - ${e.call.name}: ${e.reason}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
