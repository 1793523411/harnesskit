// Demo 7: requireApproval with a real human-in-the-loop via stdin. Each tool
// the agent wants to call is presented to the user; type 'y' or 'n'.
//
// Run: pnpm --filter @harnesskit/examples demo:approval

import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { requireApproval } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const rl = createInterface({ input, output });

const askHuman = async (toolName: string, args: unknown): Promise<boolean> => {
  const answer = await rl.question(
    `\n  >> Approve ${toolName}(${JSON.stringify(args).slice(0, 80)})? (y/n): `,
  );
  return answer.trim().toLowerCase().startsWith('y');
};

const main = async (): Promise<void> => {
  console.log('=== requireApproval — human in the loop via stdin ===');
  console.log('The agent will ask you (y/n) before any tool runs.\n');

  const result = await runAgent({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.fast,
    customHosts: ALL_CUSTOM_HOSTS,
    systemPrompt: 'You help check files. Use shell or list_files as appropriate.',
    prompt: 'Tell me what is in /etc and how big it is.',
    tools: {
      shell: {
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        execute: async () => '(host pretends shell ran)',
      },
      list_files: {
        description: 'List files',
        parameters: { type: 'object', properties: { dir: { type: 'string' } } },
        execute: async () => JSON.stringify(['hosts', 'passwd', 'os-release']),
      },
    },
    policies: [
      requireApproval({
        match: '*',
        approver: (call) => askHuman(call.name, call.input),
      }),
    ],
    maxRounds: 6,
  });

  rl.close();

  console.log('\n── result ──');
  console.log(`  rounds:  ${result.rounds}`);
  console.log(`  tools:   ${result.toolCalls.map((c) => c.name).join(', ') || '(none)'}`);
  console.log(`  denied:  ${result.events.filter((e) => e.type === 'tool.call.denied').length}`);
  console.log(`  final:   ${result.text.slice(0, 200)}`);
};

main().catch((err) => {
  rl.close();
  console.error(err);
  process.exit(1);
});
