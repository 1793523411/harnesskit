// Showcase: the @harnesskit/runner package — 30-line full agent loop with
// policies + tracing already wired. Demonstrates that "production setup" is
// not orders-of-magnitude more code than "raw API call".
// Run: VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase-runner

import { denyTools, tokenBudget } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';

const API_KEY = process.env.VOLCENGINE_API_KEY;
if (!API_KEY) {
  console.error('Set VOLCENGINE_API_KEY to run this showcase.');
  process.exit(1);
}

const main = async (): Promise<void> => {
  console.log('=== runAgent — 1-call agent loop with policies + recorder ===\n');

  const result = await runAgent({
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: API_KEY!,
    model: 'deepseek-v3-2-251201',
    customHosts: { openai: ['ark.cn-beijing.volces.com'] },

    systemPrompt: 'You are a helpful assistant. Use tools when appropriate.',
    prompt:
      'I want to know the contents of /etc/hosts and the size of /tmp. Pick safer tools when possible.',

    tools: {
      shell: {
        description: 'Run a shell command (powerful but dangerous)',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
        },
        execute: async () => '(host pretends shell ran)',
      },
      read_file: {
        description: 'Read a local file (read-only and safe)',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: async (args) => {
          const path = String(args.path);
          if (path === '/etc/hosts') {
            return '127.0.0.1 localhost\n::1 localhost\n';
          }
          return `(${path} not found)`;
        },
      },
    },

    policies: [denyTools(['shell']), tokenBudget({ output: 5_000 })],
    maxRounds: 5,
  });

  console.log(`tools used: [${result.toolCalls.map((c) => c.name).join(', ') || '(none)'}]`);
  console.log(
    `rounds: ${result.rounds}, denied: ${result.events.filter((e) => e.type === 'tool.call.denied').length}`,
  );
  console.log(`\nfinal text:\n${result.text}\n`);

  if (result.trace) {
    console.log(`trace captured: ${result.trace.events.length} events`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
