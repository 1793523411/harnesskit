// Showcase: harnesskit caps an unbounded tool-using agent via tokenBudget.
// Run: VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase-tokens

import { tokenBudget } from '@harnesskit/policy';
import { type ChatTool, printShowcase, runBaselineVsGuarded } from './_showcase-shared.js';

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

const fakeExecute = (_name: string, args: Record<string, unknown>): string => {
  const city = String(args.city ?? 'Unknown');
  return `Weather in ${city}: sunny, 22C, humidity 60%, wind 12km/h. Forecast: same conditions for the next 3 days.`;
};

const main = async (): Promise<void> => {
  const { baseline, guarded } = await runBaselineVsGuarded({
    title: 'Token budget — agent stops calling tools when budget exhausted',
    systemPrompt:
      'You help with weather queries. Use the get_weather tool for each city the user asks about.',
    userPrompt:
      'Get the weather for Tokyo, Paris, London, New York, Sydney, Berlin, Beijing, Cairo, Mumbai, and Toronto. After each tool call, briefly note what you got.',
    tools,
    fakeExecute,
    // Tight budget — should bite by the 3rd or 4th tool call.
    policies: () => [tokenBudget({ output: 200 })],
    maxRounds: 12,
  });

  const notes: string[] = [];
  if (baseline.toolNamesUsed.length > guarded.toolNamesUsed.length) {
    notes.push(
      `✓ tokenBudget capped the agent at ${guarded.toolNamesUsed.length} tool calls (baseline: ${baseline.toolNamesUsed.length})`,
    );
  }
  if (guarded.denialCount > 0) {
    notes.push(`✓ ${guarded.denialCount} call(s) denied with explicit "budget exceeded" reason`);
  }
  printShowcase('Token budget', baseline, guarded, notes);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
