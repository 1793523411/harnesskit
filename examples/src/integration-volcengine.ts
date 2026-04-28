// Real-API integration test against Volcengine (OpenAI-compatible).
// Reads API key from VOLCENGINE_API_KEY env var; never logs it.
//
// Run: VOLCENGINE_API_KEY=xxx pnpm --filter @harnesskit/examples integration-volcengine

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const API_KEY = process.env.VOLCENGINE_API_KEY;
if (!API_KEY) {
  console.error('Set VOLCENGINE_API_KEY to run this integration test.');
  process.exit(1);
}

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const TEXT_MODEL = 'deepseek-v3-2-251201';
const TOOL_MODEL = 'deepseek-v3-2-251201';
const REASONING_MODEL = 'ep-m-20260227190842-nrldn'; // doubao-seed-2-0-pro (reasoning)

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

const callModel = async (
  messages: ChatMessage[],
  opts: { tools?: ChatTool[]; stream?: boolean; model?: string } = {},
): Promise<unknown> => {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: opts.model ?? TEXT_MODEL,
      messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.stream ? { stream: true } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  if (opts.stream) {
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return null;
  }
  return await res.json();
};

const weatherTool: ChatTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};

const shellTool: ChatTool = {
  type: 'function',
  function: {
    name: 'shell',
    description: 'Execute a shell command',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    },
  },
};

const setupBus = (
  opts: { policies?: boolean; logger?: boolean } = {},
): { bus: EventBus; events: AgentEvent[]; recorder: TraceRecorder; dispose: () => void } => {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({
    name: 'collector',
    on: (e) => {
      events.push(e);
    },
  });
  if (opts.logger) {
    bus.use({
      name: 'logger',
      on: (e) => {
        if (e.type === 'tool.call.requested') {
          console.log(
            `    └─ ${e.type.padEnd(24)} ${e.call.name}(${JSON.stringify(e.call.input)})`,
          );
        } else if (e.type === 'tool.call.denied') {
          console.log(`    └─ ${e.type.padEnd(24)} ${e.call.name} -> ${e.reason}`);
        } else if (e.type === 'usage') {
          console.log(
            `    └─ ${e.type.padEnd(24)} in=${e.usage.inputTokens} out=${e.usage.outputTokens}`,
          );
        } else {
          console.log(`    └─ ${e.type.padEnd(24)} ${e.ids.turnId.slice(0, 14)}…`);
        }
      },
    });
  }
  if (opts.policies) {
    bus.use(policyToInterceptor(denyTools(['shell'])));
  }
  const recorder = new TraceRecorder();
  bus.use(recorder);
  const dispose = installFetchInterceptor({
    bus,
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },
    includeRaw: true,
  });
  return { bus, events, recorder, dispose };
};

const assert = (cond: unknown, msg: string): void => {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
};

const expectTypes = (events: AgentEvent[], types: AgentEvent['type'][]): void => {
  const actual = events.map((e) => e.type);
  for (const expected of types) {
    if (!actual.includes(expected)) {
      throw new Error(`expected ${expected} in event sequence; got [${actual.join(', ')}]`);
    }
  }
};

const test1_NonStreamingText = async (): Promise<void> => {
  console.log('\n=== Test 1: non-streaming text ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel([{ role: 'user', content: 'Say hi in one short sentence.' }]);
  dispose();

  expectTypes(events, ['turn.start', 'turn.end', 'usage']);
  const turnStart = events.find((e) => e.type === 'turn.start');
  assert(turnStart, 'turn.start emitted');
  if (turnStart?.type === 'turn.start') {
    assert(turnStart.provider === 'openai', `provider should be openai, got ${turnStart.provider}`);
    assert(turnStart.model === TEXT_MODEL, `model should be ${TEXT_MODEL}, got ${turnStart.model}`);
  }
  console.log('  ✓ event sequence correct, provider+model normalized');
};

const test2_StreamingText = async (): Promise<void> => {
  console.log('\n=== Test 2: streaming text ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel([{ role: 'user', content: 'count from 1 to 3' }], { stream: true });
  // Allow async stream consumption to finish
  await new Promise((r) => setTimeout(r, 100));
  dispose();

  expectTypes(events, ['turn.start', 'turn.end']);
  console.log('  ✓ streaming SSE parsed end-to-end');
};

const test3_NonStreamingToolCall = async (): Promise<void> => {
  console.log('\n=== Test 3: non-streaming tool call ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel(
    [{ role: 'user', content: 'What is the weather in Tokyo? Use the get_weather tool.' }],
    { tools: [weatherTool], model: TOOL_MODEL },
  );
  dispose();

  const tools = events.filter((e) => e.type === 'tool.call.requested');
  assert(tools.length >= 1, `at least one tool.call.requested expected, got ${tools.length}`);
  const t = tools[0];
  if (t?.type === 'tool.call.requested') {
    assert(t.call.name === 'get_weather', `tool name should be get_weather, got ${t.call.name}`);
    const input = t.call.input as { city?: string };
    assert(typeof input?.city === 'string', `city arg should be string, got ${typeof input?.city}`);
    console.log(`  ✓ tool.call.requested name=${t.call.name} city=${input.city}`);
  }
};

const test4_StreamingToolCall = async (): Promise<void> => {
  console.log('\n=== Test 4: streaming tool call ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel([{ role: 'user', content: 'Use get_weather for Paris.' }], {
    tools: [weatherTool],
    model: TOOL_MODEL,
    stream: true,
  });
  await new Promise((r) => setTimeout(r, 1500));
  dispose();

  const tools = events.filter((e) => e.type === 'tool.call.requested');
  assert(tools.length >= 1, `at least one tool.call.requested expected, got ${tools.length}`);
  const t = tools[0];
  if (t?.type === 'tool.call.requested') {
    const input = t.call.input as { city?: string };
    assert(
      typeof input?.city === 'string',
      `streaming should reassemble JSON args; city=${input?.city}`,
    );
    console.log(`  ✓ streaming SSE reassembled tool args: city=${input.city}`);
  }
};

const test5_DenyAndRewrite = async (): Promise<void> => {
  console.log('\n=== Test 5: deny + rewrite (2 round-trips) ===');
  const { events, dispose } = setupBus({ logger: true, policies: true });

  // Round 1: ask model to call shell. Policy denies.
  const round1 = (await callModel(
    [{ role: 'user', content: 'Run `ls /etc` using the shell tool.' }],
    { tools: [shellTool], model: TOOL_MODEL },
  )) as {
    choices: Array<{
      message: ChatMessage & {
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };

  const toolCallEntry = round1.choices[0]?.message.tool_calls?.[0];
  assert(toolCallEntry, 'model should have produced a shell tool_call');
  assert(
    toolCallEntry?.function.name === 'shell',
    `expected shell tool, got ${toolCallEntry?.function.name}`,
  );
  console.log(`    └─ round1: model wanted shell tool_call_id=${toolCallEntry?.id}`);

  const denied = events.filter((e) => e.type === 'tool.call.denied');
  assert(denied.length === 1, `should have 1 denial, got ${denied.length}`);

  // Round 2: pretend host SDK ran the shell and report back. Harnesskit should
  // rewrite our tool_result to an error before it leaves the process.
  const round2Messages: ChatMessage[] = [
    { role: 'user', content: 'Run `ls /etc` using the shell tool.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCallEntry!.id,
          type: 'function',
          function: toolCallEntry!.function,
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: toolCallEntry!.id,
      content: 'bin\netc\nhome\n(host pretends this happened)',
    },
  ];

  const eventCountBeforeRound2 = events.length;
  await callModel(round2Messages, { tools: [shellTool], model: TOOL_MODEL });
  dispose();

  // Inspect the second turn.start event to see what was actually sent
  const round2Start = events.slice(eventCountBeforeRound2).find((e) => e.type === 'turn.start') as
    | (Extract<AgentEvent, { type: 'turn.start' }> & { raw?: { body: ChatMessage[] } })
    | undefined;
  assert(round2Start, 'second turn.start should be emitted');

  const sentBody = (round2Start as unknown as { raw: { body: { messages: ChatMessage[] } } }).raw
    .body;
  const lastToolMsg = sentBody.messages.filter((m) => m.role === 'tool').at(-1);
  assert(lastToolMsg, 'should have a tool-role message in outgoing round-2 body');
  const content = lastToolMsg!.content as string;
  assert(
    typeof content === 'string' && content.includes('[harnesskit denied]'),
    `tool message content should be rewritten to denial, got: ${content}`,
  );
  console.log(`  ✓ round2 outgoing tool message rewritten to: ${content}`);
};

const test6_NonStreamingReasoning = async (): Promise<void> => {
  console.log('\n=== Test 6: non-streaming reasoning (doubao-pro) ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel([{ role: 'user', content: 'What is 2+2? Briefly.' }], {
    model: REASONING_MODEL,
  });
  dispose();

  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert(turnEnd?.type === 'turn.end', 'turn.end emitted');
  if (turnEnd?.type === 'turn.end') {
    const blocks = turnEnd.response?.content ?? [];
    const thinking = blocks.find((b) => b.type === 'thinking');
    const text = blocks.find((b) => b.type === 'text');
    assert(thinking && 'text' in thinking && thinking.text.length > 0, 'thinking block surfaced');
    assert(text && 'text' in text && text.text.length > 0, 'text block also present');
    console.log(
      `  ✓ reasoning_content normalized to thinking block (${(thinking as { text: string }).text.length} chars), text block present (${(text as { text: string }).text.length} chars)`,
    );
  }
};

const test7_StreamingReasoning = async (): Promise<void> => {
  console.log('\n=== Test 7: streaming reasoning (doubao-pro) ===');
  const { events, dispose } = setupBus({ logger: true });
  await callModel([{ role: 'user', content: 'What is 1+1? In 5 words.' }], {
    model: REASONING_MODEL,
    stream: true,
  });
  await new Promise((r) => setTimeout(r, 2500));
  dispose();

  const turnEnd = events.find((e) => e.type === 'turn.end');
  assert(turnEnd?.type === 'turn.end', 'turn.end emitted');
  if (turnEnd?.type === 'turn.end') {
    const blocks = turnEnd.response?.content ?? [];
    const thinking = blocks.find((b) => b.type === 'thinking');
    assert(
      thinking && 'text' in thinking && thinking.text.length > 0,
      'thinking block surfaced from streaming reasoning_content deltas',
    );
    console.log(
      `  ✓ streaming reasoning_content reassembled (${(thinking as { text: string }).text.length} chars)`,
    );
  }
};

const main = async (): Promise<void> => {
  const tests: Array<[string, () => Promise<void>]> = [
    ['non-streaming text', test1_NonStreamingText],
    ['streaming text', test2_StreamingText],
    ['non-streaming tool call', test3_NonStreamingToolCall],
    ['streaming tool call', test4_StreamingToolCall],
    ['deny + rewrite', test5_DenyAndRewrite],
    ['non-streaming reasoning (doubao)', test6_NonStreamingReasoning],
    ['streaming reasoning (doubao)', test7_StreamingReasoning],
  ];
  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`\n✗ FAILED: ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
  }
  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
