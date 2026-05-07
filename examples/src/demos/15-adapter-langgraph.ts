// L2 adapter demo: LangChain.js / LangGraph callback handler
//
// `harnesskitCallbacks({ bus })` returns a LangChain BaseCallbackHandler-shaped
// object. Pass it via `{ callbacks: [...] }` to any Runnable (chain, agent,
// StateGraph node) and turn.start / turn.end / usage / tool.call.requested /
// tool.call.resolved events flow into the bus.
//
// Run: OPENAI_API_KEY=… pnpm --filter @harnesskit/examples demo:adapter-langgraph

import { harnesskitCallbacks } from '@harnesskit/adapter-langgraph';
import { type AgentEvent, EventBus } from '@harnesskit/core';
import { tool } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
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

  console.log('=== LangChain.js + harnesskit L2 adapter ===\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({
    name: 'tap',
    on: (e) => {
      events.push(e);
    },
  });

  // Plain LangChain tool. Description comes from the schema.
  const getWeather = tool(
    async ({ city }: { city: string }) => {
      return `It is 22°C and partly cloudy in ${city}.`;
    },
    {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      schema: z.object({ city: z.string() }),
    },
  );

  const llm = new ChatOpenAI({ model: modelId }).bindTools([getWeather]);

  // Adapter: pass the harnesskitCallbacks handler at invocation time.
  const cb = harnesskitCallbacks({ bus });

  // First turn: model emits a tool call
  const first = await llm.invoke(
    [
      { role: 'system', content: 'Use get_weather when asked about weather.' },
      { role: 'user', content: 'What is the weather like in Tokyo right now?' },
    ],
    { callbacks: [cb] },
  );

  // Manually run the tool calls (LangChain leaves dispatch to the caller for
  // bare LLM bindings) and feed results back. handleToolStart/End fire here.
  const toolCalls = first.tool_calls ?? [];
  const toolMessages: Array<{ role: 'tool'; content: string; tool_call_id: string }> = [];
  for (const tc of toolCalls) {
    const result = await getWeather.invoke(
      { ...tc, id: tc.id ?? 'tc1', type: 'tool_call' as const },
      { callbacks: [cb] },
    );
    toolMessages.push({
      role: 'tool',
      content: typeof result === 'string' ? result : JSON.stringify(result),
      tool_call_id: tc.id ?? 'tc1',
    });
  }

  const second = await llm.invoke(
    [
      { role: 'system', content: 'Use get_weather when asked about weather.' },
      { role: 'user', content: 'What is the weather like in Tokyo right now?' },
      first,
      ...toolMessages,
    ],
    { callbacks: [cb] },
  );

  console.log(
    `final answer: ${(typeof second.content === 'string' ? second.content : JSON.stringify(second.content)).slice(0, 200)}\n`,
  );

  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log('events emitted via langgraph callbacks:');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(24)} ${v}`);

  const calls = events.filter((e) => e.type === 'tool.call.requested');
  console.log(`\ntool.call.requested events: ${calls.length}`);
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
