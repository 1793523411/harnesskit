// Demo 3: real $ tracking via costBudget with a custom pricer. Multi-turn
// agent that hits real Volcengine; we compute per-token cost ourselves.
//
// Run: pnpm --filter @harnesskit/examples demo:cost

import { costBudget, policyToInterceptor } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

// Synthetic prices (Volcengine deepseek-v3 is free, so we make up a plausible
// rate just to demonstrate the cost computation).
const PRICE_INPUT_PER_M = 0.27; // $0.27 per 1M input tokens
const PRICE_OUTPUT_PER_M = 1.1; // $1.10 per 1M output tokens

const pricer = (u: { inputTokens?: number; outputTokens?: number }) =>
  ((u.inputTokens ?? 0) * PRICE_INPUT_PER_M + (u.outputTokens ?? 0) * PRICE_OUTPUT_PER_M) /
  1_000_000;

const tools = {
  get_weather: {
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    execute: async (args: Record<string, unknown>) =>
      `Weather in ${args.city}: sunny, 22C, humidity 60%`,
  },
};

const main = async (): Promise<void> => {
  console.log('=== Cost tracking — real cumulative $ via costBudget ===\n');

  // Two runs: a generous budget that allows everything, and a tight one that
  // should bite mid-flight.
  for (const limit of [0.01, 0.0001]) {
    console.log(`── budget: $${limit} ──`);
    const result = await runAgent({
      baseUrl: v.baseUrl,
      apiKey: v.apiKey,
      model: v.fast,
      customHosts: ALL_CUSTOM_HOSTS,
      systemPrompt: 'You help with weather queries. Use the get_weather tool for each city.',
      prompt: 'Get the weather in Tokyo, Paris, London, New York, Sydney. Brief notes after each.',
      tools,
      policies: [costBudget({ totalUsd: limit, pricer })],
      maxRounds: 8,
    });

    const usage = result.events
      .filter((e) => e.type === 'usage')
      .reduce(
        (acc, e) => {
          if (e.type !== 'usage') return acc;
          return {
            input: acc.input + (e.usage.inputTokens ?? 0),
            output: acc.output + (e.usage.outputTokens ?? 0),
          };
        },
        { input: 0, output: 0 },
      );
    const totalUsd = pricer({ inputTokens: usage.input, outputTokens: usage.output });

    console.log(`  rounds:   ${result.rounds}`);
    console.log(
      `  tools:    ${result.toolCalls.length} calls (${result.toolCalls.map((c) => c.name).join(', ') || 'none'})`,
    );
    console.log(`  denied:   ${result.events.filter((e) => e.type === 'tool.call.denied').length}`);
    console.log(
      `  tokens:   in=${usage.input.toLocaleString()} out=${usage.output.toLocaleString()}`,
    );
    console.log(`  cost:     $${totalUsd.toFixed(6)}`);
    console.log('');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
