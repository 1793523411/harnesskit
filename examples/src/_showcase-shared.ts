// Shared helpers for before/after showcases.
// Each showcase imports `runBaselineVsGuarded` and provides:
//   - a system + user prompt
//   - the tool definitions the model has access to
//   - a fake host executor (so we don't need real shell / fetch / DB)
//   - a Policy[] to apply only in the "guarded" run
// The helper runs both, prints a side-by-side, and returns the events.

import { type AgentEvent, EventBus, type Policy } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const API_KEY = process.env.VOLCENGINE_API_KEY;
if (!API_KEY) {
  console.error('Set VOLCENGINE_API_KEY to run any showcase.');
  process.exit(1);
}

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const SHOWCASE_MODEL = 'deepseek-v3-2-251201';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

const callOnce = async (messages: ChatMsg[], tools: ChatTool[]): Promise<ChatMsg> => {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: SHOWCASE_MODEL, messages, tools }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices: Array<{ message: ChatMsg }> };
  return json.choices[0]!.message;
};

export interface ShowcaseConfig {
  title: string;
  systemPrompt: string;
  userPrompt: string;
  tools: ChatTool[];
  fakeExecute: (name: string, args: Record<string, unknown>) => string;
  policies: () => Policy[]; // function so each run gets fresh stateful policies
  maxRounds?: number;
}

export interface RunResult {
  events: AgentEvent[];
  toolNamesUsed: string[];
  denialCount: number;
  finalText: string;
  rounds: number;
}

const summarize = (events: AgentEvent[], finalText: string, rounds: number): RunResult => ({
  events,
  toolNamesUsed: events
    .filter(
      (e): e is AgentEvent & { type: 'tool.call.requested' } => e.type === 'tool.call.requested',
    )
    .map((e) => e.call.name),
  denialCount: events.filter((e) => e.type === 'tool.call.denied').length,
  finalText,
  rounds,
});

const runOnce = async (cfg: ShowcaseConfig, useHarness: boolean): Promise<RunResult> => {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  bus.use(new TraceRecorder());
  if (useHarness) {
    for (const policy of cfg.policies()) bus.use(policyToInterceptor(policy));
  }
  const dispose = installFetchInterceptor({
    bus,
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },
  });

  const messages: ChatMsg[] = [
    { role: 'system', content: cfg.systemPrompt },
    { role: 'user', content: cfg.userPrompt },
  ];

  const maxRounds = cfg.maxRounds ?? 6;
  let finalText = '(no final text — agent stopped mid-loop)';
  let rounds = 0;
  for (let i = 0; i < maxRounds; i++) {
    const reply = await callOnce(messages, cfg.tools);
    rounds++;
    messages.push(reply);
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      finalText = reply.content?.slice(0, 250) ?? '(empty)';
      break;
    }
    for (const tc of reply.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      const result = cfg.fakeExecute(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  dispose();
  return summarize(events, finalText, rounds);
};

export const printShowcase = (
  title: string,
  baseline: RunResult,
  guarded: RunResult,
  notes: string[] = [],
): void => {
  console.log(`\n=== ${title} ===`);
  console.log(
    `  Baseline   tools: [${baseline.toolNamesUsed.join(', ') || '(none)'}]  rounds: ${baseline.rounds}  denied: ${baseline.denialCount}`,
  );
  console.log(
    `  Guarded    tools: [${guarded.toolNamesUsed.join(', ') || '(none)'}]  rounds: ${guarded.rounds}  denied: ${guarded.denialCount}`,
  );
  console.log(`  Baseline final: ${baseline.finalText.slice(0, 120)}…`);
  console.log(`  Guarded  final: ${guarded.finalText.slice(0, 120)}…`);
  for (const n of notes) console.log(`  ${n}`);
};

export const runBaselineVsGuarded = async (
  cfg: ShowcaseConfig,
): Promise<{ baseline: RunResult; guarded: RunResult }> => {
  console.log(`\nRunning: ${cfg.title}`);
  console.log(`Prompt: ${cfg.userPrompt}`);
  const baseline = await runOnce(cfg, false);
  const guarded = await runOnce(cfg, true);
  return { baseline, guarded };
};
