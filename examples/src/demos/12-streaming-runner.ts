// Demo 12: streaming runner. Uses runAgentStream against Volcengine
// (deepseek-v3-2) so you see the model's reply token-by-token, plus a
// tool call interleaved.
//
// Run: pnpm --filter @harnesskit/examples demo:streaming

import { runAgentStream } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const main = async (): Promise<void> => {
  const v = PROVIDERS.volcengine();

  console.log('=== Streaming runner — runAgentStream against Volcengine deepseek-v3 ===\n');
  console.log(
    'Prompt: "Use the get_time tool to fetch the current ISO timestamp, then say what hour it is in San Francisco."\n',
  );
  process.stdout.write('reply: ');

  let toolStarts = 0;
  let textChars = 0;
  let lastRound = 0;
  for await (const chunk of runAgentStream({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.fast,
    customHosts: ALL_CUSTOM_HOSTS,
    prompt:
      'Use the get_time tool to fetch the current ISO timestamp, then say what hour it is in San Francisco.',
    tools: {
      get_time: {
        description: 'Get the current ISO timestamp in UTC.',
        parameters: { type: 'object', properties: {} },
        execute: () => new Date().toISOString(),
      },
    },
    maxRounds: 4,
  })) {
    if (chunk.type === 'text.delta') {
      process.stdout.write(chunk.delta);
      textChars += chunk.delta.length;
    } else if (chunk.type === 'tool.call.started') {
      toolStarts++;
      process.stdout.write(`\n[tool.call.started ${chunk.name}(${JSON.stringify(chunk.input)})]\n`);
    } else if (chunk.type === 'tool.call.finished') {
      process.stdout.write(`[tool.call.finished ${chunk.name} → ${String(chunk.result).slice(0, 60)}]\nreply: `);
    } else if (chunk.type === 'round.end') {
      lastRound = chunk.round;
    } else if (chunk.type === 'done') {
      console.log('\n');
      console.log(`✓ rounds=${chunk.result.rounds}  tool calls=${chunk.result.toolCalls.length}`);
      console.log(`  text chars streamed: ${textChars}`);
      console.log(`  tool.call.started events seen: ${toolStarts}`);
      console.log(`  last round: ${lastRound}`);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
