// Cross-provider real-API integration suite + edge case scenarios.
//
// Each provider section runs only if its env var is set:
//   VOLCENGINE_API_KEY  — used for unlimited-token edge case tests
//   DEEPSEEK_API_KEY    — DeepSeek direct (api.deepseek.com)
//   MINIMAX_API_KEY     — MiniMax (Anthropic protocol on api.minimaxi.com)
//   OPENAI_API_KEY      — OpenAI direct
//
// Run: VOLCENGINE_API_KEY=… DEEPSEEK_API_KEY=… pnpm --filter @harnesskit/examples integration-real-api

import { type AgentEvent, EventBus, createSessionId } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const ENV = {
  VOLCENGINE: process.env.VOLCENGINE_API_KEY,
  DEEPSEEK: process.env.DEEPSEEK_API_KEY,
  MINIMAX: process.env.MINIMAX_API_KEY,
  OPENAI: process.env.OPENAI_API_KEY,
};

const PROVIDERS = {
  volcengine: {
    enabled: !!ENV.VOLCENGINE,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: ENV.VOLCENGINE,
    chatModel: 'deepseek-v3-2-251201',
    reasoningModel: 'ep-m-20260227190842-nrldn',
    toolModel: 'deepseek-v3-2-251201',
  },
  deepseek: {
    enabled: !!ENV.DEEPSEEK,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: ENV.DEEPSEEK,
    chatModel: 'deepseek-chat',
    reasoningModel: 'deepseek-reasoner',
  },
  minimax: {
    enabled: !!ENV.MINIMAX,
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiKey: ENV.MINIMAX,
    chatModel: 'MiniMax-M2.7-highspeed',
  },
  openai: {
    enabled: !!ENV.OPENAI,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: ENV.OPENAI,
    chatModel: 'gpt-5.4-nano',
  },
};

const customHosts = {
  openai: ['api.deepseek.com', 'ark.cn-beijing.volces.com'],
  anthropic: ['api.minimaxi.com'],
};

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | unknown[] | null;
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

const callOpenAICompat = async (
  baseUrl: string,
  apiKey: string,
  body: {
    model: string;
    messages: ChatMsg[];
    tools?: ChatTool[];
    stream?: boolean;
  },
): Promise<unknown> => {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (body.stream) {
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return null;
  }
  return await res.json();
};

interface AnthropicMsg {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | {
            type: 'tool_result';
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }
      >;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

const callAnthropicCompat = async (
  baseUrl: string,
  apiKey: string,
  body: {
    model: string;
    messages: AnthropicMsg[];
    max_tokens: number;
    tools?: AnthropicTool[];
    stream?: boolean;
    system?: string;
  },
): Promise<unknown> => {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (body.stream) {
    const reader = res.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return null;
  }
  return await res.json();
};

const setupBus = (
  opts: { logger?: boolean; policies?: boolean; sessionId?: () => string } = {},
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
  const installOpts: Parameters<typeof installFetchInterceptor>[0] = {
    bus,
    customHosts,
    includeRaw: true,
  };
  if (opts.sessionId) installOpts.getSessionId = opts.sessionId;
  const dispose = installFetchInterceptor(installOpts);
  return { bus, events, recorder, dispose };
};

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

// ── Per-provider smoke tests ──────────────────────────────────────────

const smokeDeepSeek = async (): Promise<void> => {
  if (!PROVIDERS.deepseek.enabled) {
    console.log('\n=== DeepSeek smoke: SKIPPED (DEEPSEEK_API_KEY unset) ===');
    return;
  }
  console.log('\n=== DeepSeek smoke: chat + reasoning ===');
  const { events, dispose } = setupBus({ logger: true });

  await callOpenAICompat(PROVIDERS.deepseek.baseUrl, PROVIDERS.deepseek.apiKey!, {
    model: PROVIDERS.deepseek.chatModel,
    messages: [{ role: 'user', content: 'Say "hi" in one word.' }],
  });
  const turnStart = events.find((e) => e.type === 'turn.start');
  if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
  assert(turnStart.provider === 'openai', `expected provider 'openai', got ${turnStart.provider}`);
  console.log('  ✓ deepseek-chat detected via customHosts');

  await callOpenAICompat(PROVIDERS.deepseek.baseUrl, PROVIDERS.deepseek.apiKey!, {
    model: PROVIDERS.deepseek.reasoningModel,
    messages: [{ role: 'user', content: 'What is 2+2? In 5 words.' }],
  });
  const turnEnds = events.filter((e) => e.type === 'turn.end');
  const reasoningTurn = turnEnds[turnEnds.length - 1];
  if (reasoningTurn?.type !== 'turn.end') throw new Error('expected turn.end');
  const blocks = reasoningTurn.response?.content ?? [];
  const thinking = blocks.find((b) => b.type === 'thinking');
  assert(thinking, 'deepseek-reasoner should produce thinking block');
  console.log(
    `  ✓ deepseek-reasoner reasoning_content normalized to thinking (${(thinking as { text: string }).text.length} chars)`,
  );
  dispose();
};

const smokeMinimax = async (): Promise<void> => {
  if (!PROVIDERS.minimax.enabled) {
    console.log('\n=== MiniMax smoke: SKIPPED (MINIMAX_API_KEY unset) ===');
    return;
  }
  console.log('\n=== MiniMax smoke: Anthropic protocol on non-default host ===');
  const { events, dispose } = setupBus({ logger: true });

  await callAnthropicCompat(PROVIDERS.minimax.baseUrl, PROVIDERS.minimax.apiKey!, {
    model: PROVIDERS.minimax.chatModel,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
  });
  const turnStart = events.find((e) => e.type === 'turn.start');
  if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
  assert(
    turnStart.provider === 'anthropic',
    `expected provider 'anthropic', got ${turnStart.provider}`,
  );
  assert(turnStart.model === PROVIDERS.minimax.chatModel, `model mismatch: ${turnStart.model}`);
  console.log('  ✓ MiniMax routed through anthropic provider via customHosts');
  dispose();
};

const smokeOpenAI = async (): Promise<void> => {
  if (!PROVIDERS.openai.enabled) {
    console.log('\n=== OpenAI smoke: SKIPPED (OPENAI_API_KEY unset) ===');
    return;
  }
  console.log('\n=== OpenAI smoke: gpt-5.4-nano basic chat ===');
  const { events, dispose } = setupBus({ logger: true });

  await callOpenAICompat(PROVIDERS.openai.baseUrl, PROVIDERS.openai.apiKey!, {
    model: PROVIDERS.openai.chatModel,
    messages: [{ role: 'user', content: 'Say "hi" in one word.' }],
  });
  const turnStart = events.find((e) => e.type === 'turn.start');
  if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
  assert(turnStart.provider === 'openai', `provider should be openai, got ${turnStart.provider}`);
  console.log(`  ✓ ${PROVIDERS.openai.chatModel} traffic captured`);
  dispose();
};

// ── Edge cases on Volcengine (unlimited tokens) ───────────────────────

const edgeMultiTurnToolChain = async (): Promise<void> => {
  if (!PROVIDERS.volcengine.enabled) {
    console.log('\n=== Edge: multi-turn tool chain: SKIPPED ===');
    return;
  }
  console.log('\n=== Edge: multi-turn tool chain (3 rounds) ===');
  const { events, dispose } = setupBus({ logger: true });

  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ];

  const messages: ChatMsg[] = [
    {
      role: 'user',
      content:
        'Get weather for Tokyo, then for Paris, then summarize both in one sentence. Use the get_weather tool twice.',
    },
  ];

  let toolRounds = 0;
  for (let round = 0; round < 4 && toolRounds < 3; round++) {
    const resp = (await callOpenAICompat(
      PROVIDERS.volcengine.baseUrl,
      PROVIDERS.volcengine.apiKey!,
      { model: PROVIDERS.volcengine.toolModel, messages, tools },
    )) as {
      choices: Array<{
        message: ChatMsg & {
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    messages.push(msg as ChatMsg);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolRounds++;
      for (const tc of msg.tool_calls) {
        const args = JSON.parse(tc.function.arguments) as { city: string };
        const fakeWeather = args.city.toLowerCase() === 'tokyo' ? 'sunny, 22C' : 'rainy, 14C';
        messages.push({ role: 'tool', tool_call_id: tc.id, content: fakeWeather });
      }
    } else {
      break;
    }
  }
  dispose();

  const requested = events.filter((e) => e.type === 'tool.call.requested');
  assert(
    requested.length >= 2,
    `expected at least 2 tool calls across the chain, got ${requested.length}`,
  );
  console.log(
    `  ✓ chain produced ${requested.length} tool.call.requested events across ${toolRounds} model turns`,
  );
};

const edgeLongReasoning = async (): Promise<void> => {
  if (!PROVIDERS.volcengine.enabled) {
    console.log('\n=== Edge: long reasoning: SKIPPED ===');
    return;
  }
  console.log('\n=== Edge: long reasoning streaming reassembly ===');
  const { events, dispose } = setupBus({ logger: true });

  await callOpenAICompat(PROVIDERS.volcengine.baseUrl, PROVIDERS.volcengine.apiKey!, {
    model: PROVIDERS.volcengine.reasoningModel,
    stream: true,
    messages: [
      {
        role: 'user',
        content:
          'Explain why 1+1=2 from set theory and Peano axioms in 8+ paragraphs of careful reasoning. Then write your final answer in 3 words.',
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 30_000));
  dispose();

  const turnEnd = events.find((e) => e.type === 'turn.end');
  if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
  const blocks = turnEnd.response?.content ?? [];
  const thinking = blocks.find((b) => b.type === 'thinking');
  assert(
    thinking && 'text' in thinking && thinking.text.length > 2000,
    `expected long reasoning >2000 chars, got ${(thinking as { text?: string })?.text?.length ?? 0}`,
  );
  console.log(
    `  ✓ long reasoning reassembled: ${(thinking as { text: string }).text.length} chars`,
  );
};

const edgeConcurrentSessions = async (): Promise<void> => {
  if (!PROVIDERS.volcengine.enabled) {
    console.log('\n=== Edge: concurrent sessions: SKIPPED ===');
    return;
  }
  console.log('\n=== Edge: 3 concurrent sessions through one bus ===');
  const sessionCounter = { n: 0 };
  const sessionResolver = () => `sess_concurrent_${sessionCounter.n++}_${createSessionId()}`;
  const { events, dispose } = setupBus({ logger: false, sessionId: sessionResolver });

  const tasks = [1, 2, 3].map((n) =>
    callOpenAICompat(PROVIDERS.volcengine.baseUrl, PROVIDERS.volcengine.apiKey!, {
      model: PROVIDERS.volcengine.chatModel,
      messages: [{ role: 'user', content: `Say "task ${n}" in those exact two words.` }],
    }),
  );
  await Promise.all(tasks);
  dispose();

  const turnStarts = events.filter((e) => e.type === 'turn.start');
  const sessionIds = new Set(turnStarts.map((e) => e.ids.sessionId));
  assert(turnStarts.length === 3, `expected 3 turn.start, got ${turnStarts.length}`);
  assert(
    sessionIds.size === 3,
    `expected 3 distinct sessionIds, got ${sessionIds.size}: ${[...sessionIds].join(', ')}`,
  );
  console.log('  ✓ 3 concurrent calls each got distinct sessionId via getSessionId resolver');
};

const edgeToolErrorResult = async (): Promise<void> => {
  if (!PROVIDERS.volcengine.enabled) {
    console.log('\n=== Edge: tool error result: SKIPPED ===');
    return;
  }
  console.log('\n=== Edge: model receives tool error and adapts ===');
  const { events, dispose } = setupBus({ logger: true });

  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ];

  const round1 = (await callOpenAICompat(
    PROVIDERS.volcengine.baseUrl,
    PROVIDERS.volcengine.apiKey!,
    {
      model: PROVIDERS.volcengine.toolModel,
      tools,
      messages: [{ role: 'user', content: 'Get weather for Paris.' }],
    },
  )) as {
    choices: Array<{
      message: { tool_calls?: Array<{ id: string; function: { arguments: string } }> };
    }>;
  };

  const tc = round1.choices[0]?.message.tool_calls?.[0];
  assert(tc, 'model should call get_weather');

  // Round 2: simulate the tool throwing
  const round2 = (await callOpenAICompat(
    PROVIDERS.volcengine.baseUrl,
    PROVIDERS.volcengine.apiKey!,
    {
      model: PROVIDERS.volcengine.toolModel,
      tools,
      messages: [
        { role: 'user', content: 'Get weather for Paris.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: tc!.id,
              type: 'function',
              function: { name: 'get_weather', arguments: tc!.function.arguments },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: tc!.id,
          content: 'ERROR: weather service unavailable (HTTP 503)',
        },
      ],
    },
  )) as { choices: Array<{ message: { content?: string | null } }> };

  const finalText = round2.choices[0]?.message.content;
  assert(
    typeof finalText === 'string' && finalText.length > 0,
    'model should respond with text after seeing tool error',
  );
  console.log(`  ✓ model adapted to tool error; reply: "${finalText?.slice(0, 80)}…"`);
  dispose();
};

// ── Runner ────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const tests: Array<[string, () => Promise<void>]> = [
    ['DeepSeek direct smoke', smokeDeepSeek],
    ['MiniMax (Anthropic) smoke', smokeMinimax],
    ['OpenAI smoke', smokeOpenAI],
    ['edge: multi-turn tool chain', edgeMultiTurnToolChain],
    ['edge: long reasoning streaming', edgeLongReasoning],
    ['edge: concurrent sessions', edgeConcurrentSessions],
    ['edge: tool error result', edgeToolErrorResult],
  ];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const [name, fn] of tests) {
    try {
      const before = console.log;
      let sawSkipped = false;
      console.log = (...args: unknown[]) => {
        const s = args.join(' ');
        if (s.includes(': SKIPPED')) sawSkipped = true;
        before(...args);
      };
      await fn();
      console.log = before;
      if (sawSkipped) skipped++;
      else passed++;
    } catch (err) {
      failed++;
      console.error(`\n✗ FAILED: ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
  }
  console.log(`\n=== summary: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
