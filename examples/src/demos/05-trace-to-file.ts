// Demo 5: run an agent, write the captured trace to a JSON file. Then drop
// the file into apps/trace-viewer/index.html for a visual timeline.
//
// Run: pnpm --filter @harnesskit/examples demo:trace-file

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { traceToJson } from '@harnesskit/eval';
import { denyTools, tokenBudget } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const main = async (): Promise<void> => {
  console.log('=== Trace to file — run an agent, dump the trace JSON ===\n');

  const result = await runAgent({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.fast,
    customHosts: ALL_CUSTOM_HOSTS,
    systemPrompt: 'You help check files.',
    prompt:
      'Try to list files in /var/log AND show their sizes (use shell, list_files, or read_file as needed).',
    tools: {
      shell: {
        description: 'Run shell',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        execute: async (args: Record<string, unknown>) => `(host pretends \`${args.cmd}\` ran)`,
      },
      list_files: {
        description: 'List files',
        parameters: { type: 'object', properties: { dir: { type: 'string' } } },
        execute: async () => JSON.stringify(['app.log', 'auth.log', 'system.log']),
      },
      read_file: {
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async () => 'file contents (78 bytes)',
      },
    },
    policies: [denyTools(['shell']), tokenBudget({ output: 5_000 })],
    maxRounds: 6,
  });

  if (!result.trace) {
    console.error('no trace captured');
    process.exit(1);
  }

  const json = traceToJson(result.trace);
  const out = resolve(process.cwd(), 'trace.json');
  writeFileSync(out, json);

  console.log(`✓ wrote trace with ${result.trace.events.length} events to ${out}`);
  console.log(`  size:    ${json.length.toLocaleString()} bytes`);
  console.log(`  rounds:  ${result.rounds}`);
  console.log(`  denied:  ${result.events.filter((e) => e.type === 'tool.call.denied').length}`);
  console.log('');
  console.log('Now open apps/trace-viewer/index.html in your browser and drop the file in.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
