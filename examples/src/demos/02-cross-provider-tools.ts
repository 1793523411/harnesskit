// Demo 2: same tool definition, 3 wire formats — verify the harness emits
// identical normalized tool.call.requested events regardless of provider.
//
// Run: pnpm --filter @harnesskit/examples demo:cross-provider-tools

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const PROMPT = 'Use the get_weather tool to find the weather in Tokyo.';

const callOpenAICompat = async (baseUrl: string, apiKey: string, model: string): Promise<void> => {
  await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [
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
      ],
    }),
  }).then((r) => r.json());
};

const callAnthropic = async (baseUrl: string, apiKey: string, model: string): Promise<void> => {
  await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: PROMPT }],
      tools: [
        {
          name: 'get_weather',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    }),
  }).then((r) => r.json());
};

interface Run {
  label: string;
  fn: () => Promise<void>;
}

const runs: Run[] = [];
try {
  const v = PROVIDERS.volcengine();
  runs.push({
    label: 'OpenAI-Compat via Volcengine (deepseek-v3)',
    fn: () => callOpenAICompat(v.baseUrl, v.apiKey, v.fast),
  });
} catch {
  /* skip */
}
try {
  const c = PROVIDERS.poloClaude();
  runs.push({
    label: 'Anthropic Messages via Polo (claude-sonnet-4)',
    fn: () => callAnthropic(c.baseUrl, c.apiKey, c.fast),
  });
} catch {
  /* skip */
}
try {
  const m = PROVIDERS.minimax();
  runs.push({
    label: 'Anthropic Messages via MiniMax',
    fn: () => callAnthropic(m.baseUrl, m.apiKey, m.fast),
  });
} catch {
  /* skip */
}
try {
  const g = PROVIDERS.poloGemini();
  runs.push({
    label: 'OpenAI-Compat (Gemini) via Polo',
    fn: () => callOpenAICompat(g.baseUrl, g.apiKey, g.fast),
  });
} catch {
  /* skip */
}

if (runs.length === 0) {
  console.error(
    'Need at least one of VOLCENGINE / POLO_CLAUDE / MINIMAX / POLO_GEMINI configured.',
  );
  process.exit(1);
}

const main = async (): Promise<void> => {
  console.log(`=== Cross-provider tools — same tool, ${runs.length} providers ===`);
  console.log(`Prompt: ${PROMPT}\n`);

  for (const run of runs) {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.use({ on: (e) => void events.push(e) });
    const dispose = installFetchInterceptor({ bus, customHosts: ALL_CUSTOM_HOSTS });
    try {
      await run.fn();
    } catch (err) {
      console.log(`[${run.label}] ERROR: ${err instanceof Error ? err.message : String(err)}`);
      dispose();
      continue;
    }
    dispose();

    const turnStart = events.find((e) => e.type === 'turn.start');
    const tool = events.find((e) => e.type === 'tool.call.requested');
    if (turnStart?.type === 'turn.start' && tool?.type === 'tool.call.requested') {
      console.log(`[${run.label}]`);
      console.log(`  provider tag: ${turnStart.provider}`);
      console.log(`  model:        ${turnStart.model}`);
      console.log(`  tool name:    ${tool.call.name}`);
      console.log(`  tool input:   ${JSON.stringify(tool.call.input)}`);
      console.log('');
    } else {
      console.log(`[${run.label}] (no tool call surfaced — model may have answered with text)`);
    }
  }
  console.log(
    'All providers emit the same normalized AgentEvent shape — your downstream consumers (policy/eval/recorder) do not need provider-specific code.',
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
