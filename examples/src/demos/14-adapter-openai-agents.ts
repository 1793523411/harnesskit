// L2 adapter demo: OpenAI Agents SDK
//
// `attachOpenAIAgentsAdapter({ bus, runHooks })` listens on the SDK's
// `RunHooks` event emitter. The Runner instance itself extends RunHooks
// so we pass it in directly. We get tool.call.requested / tool.call.resolved
// / session.start events on the bus while the agent runs.
//
// Run: OPENAI_API_KEY=… pnpm --filter @harnesskit/examples demo:adapter-openai-agents

import { attachOpenAIAgentsAdapter } from '@harnesskit/adapter-openai-agents';
import { type AgentEvent, EventBus } from '@harnesskit/core';
import { Agent, Runner, tool } from '@openai/agents';
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
  process.env.OPENAI_API_KEY = apiKey;
  const modelId = process.env.OPENAI_MINI_MODEL ?? 'gpt-4o-mini';

  console.log('=== OpenAI Agents SDK + harnesskit L2 adapter ===\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({
    name: 'tap',
    on: (e) => {
      events.push(e);
    },
  });

  // Plain @openai/agents setup — exactly what users would already write.
  const lookupTool = tool({
    name: 'lookup_user',
    description: 'Look up a user by id.',
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) =>
      JSON.stringify({ id, name: 'Alice', tier: 'gold', joined: '2024-01-12' }),
  });

  const echoTool = tool({
    name: 'echo',
    description: 'Echo back the input message.',
    parameters: z.object({ message: z.string() }),
    execute: async ({ message }) => message.toUpperCase(),
  });

  const agent = new Agent({
    name: 'support-bot',
    instructions: 'You answer support questions. Use the tools when relevant.',
    model: modelId,
    tools: [lookupTool, echoTool],
  });

  const runner = new Runner();

  // L2 adapter: attach to the runner's RunHooks. Returned dispose() unbinds.
  const detach = attachOpenAIAgentsAdapter({ bus, runHooks: runner });

  const result = await runner.run(agent, 'Look up user u_42, then echo a greeting for them.');

  detach();

  console.log(`final answer: ${String(result.finalOutput).slice(0, 200)}\n`);

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log('events emitted via L2 adapter:');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(24)} ${v}`);

  const calls = events.filter((e) => e.type === 'tool.call.requested');
  console.log(`\ntool.call.requested: ${calls.length}`);
  for (const e of calls) {
    if (e.type === 'tool.call.requested') {
      console.log(`  - ${e.call.name}(${JSON.stringify(e.call.input).slice(0, 80)})`);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
