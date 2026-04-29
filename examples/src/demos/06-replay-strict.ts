// Demo 6: capture a trace under loose policy, then replay it through a
// stricter policy and count what would have been blocked. Pre-deploy
// "what-if" check for a candidate policy.
//
// Run: pnpm --filter @harnesskit/examples demo:replay

import { EventBus } from '@harnesskit/core';
import { replayTrace } from '@harnesskit/eval';
import { allowTools, policyToInterceptor } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const main = async (): Promise<void> => {
  console.log('=== Replay against stricter policy — what-if analysis ===\n');

  // Phase 1 — capture under loose policy (no constraints, recorder only)
  console.log('Phase 1: capture under loose policy …');
  const loose = await runAgent({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.fast,
    customHosts: ALL_CUSTOM_HOSTS,
    systemPrompt: 'You investigate file systems.',
    prompt:
      'Find out what is in /var/log. Use shell, list_files, or read_file — whichever you prefer.',
    tools: {
      shell: {
        description: 'Run shell',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        execute: async () => '(host pretends shell ran)',
      },
      list_files: {
        description: 'List files in a directory',
        parameters: { type: 'object', properties: { dir: { type: 'string' } } },
        execute: async () => JSON.stringify(['app.log', 'auth.log']),
      },
      read_file: {
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async () => 'log line 1\nlog line 2',
      },
    },
    maxRounds: 6,
  });
  if (!loose.trace) {
    console.error('no trace');
    process.exit(1);
  }
  console.log(
    `  captured ${loose.trace.events.length} events; tools used: [${loose.toolCalls.map((c) => c.name).join(', ')}]\n`,
  );

  // Phase 2 — replay through a strict policy
  console.log('Phase 2: replay through strict allowTools(["read_file"]) …');
  const strictBus = new EventBus();
  strictBus.use(policyToInterceptor(allowTools(['read_file'])));
  const replayResult = await replayTrace(loose.trace, strictBus);

  console.log(`  would block ${replayResult.denials.length} call(s):`);
  for (const d of replayResult.denials) {
    if (d.event.type === 'tool.call.requested') {
      console.log(`    - ${d.event.call.name}(${JSON.stringify(d.event.call.input).slice(0, 60)})`);
      console.log(`      reason: ${d.reason}`);
    }
  }
  if (replayResult.denials.length === 0) {
    console.log('  (none — strict policy would have allowed everything in this trace)');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
