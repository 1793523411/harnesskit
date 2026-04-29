// Demo 1: same prompt, 4 reasoning models side-by-side.
// Compares: thinking-block char count, final answer, tokens, latency.
//
// Run: pnpm --filter @harnesskit/examples demo:reasoning

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const PROMPT =
  'A bat and a ball cost $1.10 in total. The bat costs $1 more than the ball. How much does the ball cost? Walk through your reasoning, then give the final answer in one sentence.';

interface ProviderRun {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const runs: ProviderRun[] = [];
try {
  const v = PROVIDERS.volcengine();
  runs.push({
    label: 'doubao-pro (volcengine)',
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.reasoning,
  });
} catch {
  /* skip */
}
try {
  const d = PROVIDERS.deepseek();
  runs.push({
    label: 'deepseek-reasoner',
    baseUrl: d.baseUrl,
    apiKey: d.apiKey,
    model: d.reasoning,
  });
} catch {
  /* skip */
}
try {
  const g = PROVIDERS.poloGemini();
  runs.push({
    label: 'gemini-3-flash-thinking (polo)',
    baseUrl: g.baseUrl,
    apiKey: g.apiKey,
    model: g.thinking,
  });
} catch {
  /* skip */
}
try {
  const p = PROVIDERS.poloGpt();
  runs.push({ label: 'gpt-5 (polo)', baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.full });
} catch {
  /* skip */
}

if (runs.length === 0) {
  console.error(
    'No reasoning providers configured. Set at least one of VOLCENGINE_API_KEY / DEEPSEEK_API_KEY / POLO_GEMINI_API_KEY / POLO_GPT_API_KEY.',
  );
  process.exit(1);
}

const callOne = async (
  run: ProviderRun,
): Promise<{
  events: AgentEvent[];
  durationMs: number;
}> => {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  const dispose = installFetchInterceptor({ bus, customHosts: ALL_CUSTOM_HOSTS });
  const t0 = Date.now();
  const res = await fetch(`${run.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${run.apiKey}`,
    },
    body: JSON.stringify({
      model: run.model,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  await res.json();
  const durationMs = Date.now() - t0;
  dispose();
  return { events, durationMs };
};

const main = async (): Promise<void> => {
  console.log(`=== Reasoning Showdown — same prompt, ${runs.length} models ===`);
  console.log(`Prompt: ${PROMPT}\n`);

  console.log('label                              | thinking | text | in→out tokens | duration');
  console.log('-'.repeat(95));
  for (const run of runs) {
    try {
      const { events, durationMs } = await callOne(run);
      const turnEnd = events.find((e) => e.type === 'turn.end');
      const usage = events.find((e) => e.type === 'usage');
      let thinkingChars = 0;
      let textChars = 0;
      if (turnEnd?.type === 'turn.end') {
        for (const b of turnEnd.response?.content ?? []) {
          if (b.type === 'thinking') thinkingChars += b.text.length;
          else if (b.type === 'text') textChars += b.text.length;
        }
      }
      const inT = usage?.type === 'usage' ? (usage.usage.inputTokens ?? 0) : 0;
      const outT = usage?.type === 'usage' ? (usage.usage.outputTokens ?? 0) : 0;
      console.log(
        `${run.label.padEnd(35)}| ${String(thinkingChars).padStart(8)} | ${String(textChars).padStart(4)} | ${String(inT).padStart(5)}→${String(outT).padEnd(7)} | ${durationMs}ms`,
      );
    } catch (err) {
      console.log(
        `${run.label.padEnd(35)}| ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
