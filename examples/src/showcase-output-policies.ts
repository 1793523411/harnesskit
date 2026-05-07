// Showcase: three audit-style policies that look at outputs (not inputs).
//
// Most policies in this repo deny *outgoing* tool calls. The three covered
// here run on what the model produced or what the tool returned:
//
//   • outputContentRegex — flags tool_result content matching a regex
//                          (typical use: secret leaks, prompt injection markers)
//   • outputPiiScan      — same shape, but for PII (email/SSN/credit card/…)
//   • reasoningBudget    — caps cumulative `thinking` chars per session
//                          (typical use: stop runaway chain-of-thought)
//
// All three are observe-only: they emit `error` events / deny once exceeded,
// they do not rewrite the wire payload (use redactPiiInToolResults for that).
//
// Run: VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase-output-policies

import {
  type AgentEvent,
  EventBus,
  createCallId,
  createSessionId,
  createTurnId,
} from '@harnesskit/core';
import {
  outputContentRegex,
  outputPiiScan,
  policyToInterceptor,
  reasoningBudget,
} from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const API_KEY = process.env.VOLCENGINE_API_KEY;
if (!API_KEY) {
  console.error('Set VOLCENGINE_API_KEY to run this showcase.');
  process.exit(1);
}

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const FAST_MODEL = process.env.VOLCENGINE_FAST_MODEL ?? 'deepseek-v3-2-251201';
const REASONING_MODEL = process.env.VOLCENGINE_REASONING_MODEL ?? 'ep-m-20260227190842-nrldn';

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
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

const callOnce = async (
  model: string,
  messages: ChatMsg[],
  tools?: ChatTool[],
): Promise<ChatMsg> => {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model, messages, ...(tools ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: Array<{ message: ChatMsg }> };
  return json.choices[0]!.message;
};

// ── scenario 1: output audit on tool_result content ────────────────────
//
// We run a small loop where the model calls a fake `lookup_user` tool. The
// tool returns content that contains:
//   - a Bearer-style API token (caught by outputContentRegex)
//   - an email address  (caught by outputPiiScan)
//
// Note: tool.call.resolved is not emitted by the L1 fetch interceptor —
// it's an L2-shape event. This showcase emits it manually after running
// each tool, which is what an L2 adapter would do for you in a real
// integration (see @harnesskit/adapter-langgraph / -vercel-ai / -claude-agent-sdk).

const TOOL_OUTPUT = [
  'Lookup result for user u_42:',
  '  email: alice.park@example.com',
  '  api_key: Bearer ABCDEF0123456789',
  '  status: active',
].join('\n');

const scenario1 = async (): Promise<void> => {
  console.log('═══ Scenario 1: outputContentRegex + outputPiiScan ═══\n');

  const bus = new EventBus();
  const errors: AgentEvent[] = [];
  bus.use({
    name: 'capture-errors',
    on: (e) => {
      if (e.type === 'error') errors.push(e);
    },
  });

  // Two audit interceptors. Both emit `error` events when their pattern hits;
  // neither rewrites the payload.
  bus.use(
    outputContentRegex({
      pattern: /Bearer\s+[A-Z0-9]+/,
      message: 'Bearer token leaked through tool_result',
    }),
  );
  bus.use(outputPiiScan({ patterns: ['email', 'ssn'] }));

  const dispose = installFetchInterceptor({
    bus,
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },
  });

  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_user',
        description: 'Look up a user by id. Returns sensitive details.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  ];

  const messages: ChatMsg[] = [
    { role: 'system', content: 'You help with user lookups. Use the lookup_user tool.' },
    { role: 'user', content: 'Look up user u_42 and summarize what you got back.' },
  ];

  // Stable session id so audit events tie back to one session
  const sessionId = createSessionId();

  for (let round = 0; round < 4; round++) {
    const reply = await callOnce(FAST_MODEL, messages, tools);
    messages.push(reply);
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      console.log(`  [final] ${reply.content?.slice(0, 160) ?? '(empty)'}\n`);
      break;
    }
    for (const tc of reply.tool_calls) {
      console.log(`  [model wants] ${tc.function.name}(${tc.function.arguments})`);
      // Pretend to execute, then manually emit tool.call.resolved so the
      // audit interceptors get a chance to scan the content.
      const callId = tc.id || createCallId();
      const turnId = createTurnId();
      await bus.emit({
        type: 'tool.call.resolved',
        ts: Date.now(),
        ids: { sessionId, turnId, callId },
        source: 'l2',
        call: { id: callId, name: tc.function.name, input: JSON.parse(tc.function.arguments) },
        result: { content: TOOL_OUTPUT },
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: TOOL_OUTPUT });
    }
  }

  dispose();

  console.log(`  ${errors.length} audit error(s) captured by interceptors:`);
  for (const err of errors) {
    if (err.type === 'error') console.log(`    - ${err.message}`);
  }
  console.log();
};

// ── scenario 2: reasoningBudget caps cumulative thinking-block chars ───
//
// reasoningBudget observes turn.end events for `thinking` content blocks
// (the L1 fetch interceptor normalises reasoning_content into thinking
// blocks for OpenAI-compat reasoning models). Once the cumulative char
// count crosses the cap, any subsequent tool call is denied.

const scenario2 = async (): Promise<void> => {
  console.log('═══ Scenario 2: reasoningBudget on a real reasoning model ═══\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ name: 'tap', on: (e) => void events.push(e) });

  // Cap at 200 chars of thinking. doubao-pro typically emits 1k+ chars on
  // a multi-step problem, so the second turn's tool call should get denied.
  const CHARS_CAP = 200;
  bus.use(policyToInterceptor(reasoningBudget({ chars: CHARS_CAP })));

  const dispose = installFetchInterceptor({
    bus,
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },
  });

  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_fact',
        description: 'Returns a single fact about a topic.',
        parameters: {
          type: 'object',
          properties: { topic: { type: 'string' } },
          required: ['topic'],
        },
      },
    },
  ];

  const messages: ChatMsg[] = [
    {
      role: 'system',
      content:
        'You are a careful reasoner. Think step-by-step before answering. Use the get_fact tool when you need a fact.',
    },
    {
      role: 'user',
      content:
        'Walk me through how you would compute 17 * 23 by hand, then use get_fact to confirm one historical fact about long multiplication, then give me the final product.',
    },
  ];

  for (let round = 0; round < 3; round++) {
    const reply = await callOnce(REASONING_MODEL, messages, tools);
    messages.push(reply);

    // Print thinking chars seen so far
    const thinkingChars = events
      .filter((e) => e.type === 'turn.end')
      .flatMap((e) => (e.type === 'turn.end' ? (e.response?.content ?? []) : []))
      .filter((b) => b.type === 'thinking')
      .reduce((sum, b) => sum + (b as { type: 'thinking'; text: string }).text.length, 0);
    console.log(
      `  [round ${round + 1}] thinking chars so far: ${thinkingChars} (cap ${CHARS_CAP})`,
    );

    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      console.log(`  [final] ${reply.content?.slice(0, 160) ?? '(empty)'}\n`);
      break;
    }
    let denied = false;
    for (const tc of reply.tool_calls) {
      const wasDenied = events.some((e) => e.type === 'tool.call.denied' && e.call.id === tc.id);
      if (wasDenied) {
        const denyEvt = events.find((e) => e.type === 'tool.call.denied' && e.call.id === tc.id);
        const reason = denyEvt && denyEvt.type === 'tool.call.denied' ? denyEvt.reason : 'unknown';
        console.log(`  [model wants] ${tc.function.name}({…}) → DENIED: ${reason}`);
        // Feed the denial back as a tool message so the model can react.
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `[harnesskit denied] ${reason}`,
        });
        denied = true;
      } else {
        console.log(`  [model wants] ${tc.function.name}(${tc.function.arguments}) → allow`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            'Long multiplication has been formalised since at least the 9th-century work of al-Khwarizmi.',
        });
      }
    }
    if (denied) {
      // Give the model one more chance to wrap up given the denial. If it does,
      // the loop's continue; if it produces another tool call it'll be denied
      // again (cumulative thinking is monotonic — once over budget, stays over).
    }
  }

  dispose();

  const denials = events.filter((e) => e.type === 'tool.call.denied');
  if (denials.length === 0) {
    console.log('  (no denial fired — the model may have stayed under the budget on this run)');
  } else {
    console.log(`\n  ✓ ${denials.length} tool call(s) denied by reasoningBudget`);
  }
};

const main = async (): Promise<void> => {
  await scenario1();
  await scenario2();
  console.log('\n✓ outputContentRegex / outputPiiScan / reasoningBudget all exercised end-to-end.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
