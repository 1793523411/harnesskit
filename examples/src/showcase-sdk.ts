// Showcase: @harnesskit/sdk high-level facade.
//
// This intentionally wires both layers:
// - L1 fetch interception observes model traffic and rewrites denied tool results.
// - SDK wrapTools gates host-side execution before a dangerous tool runs.
//
// Run with a real model:
//   VOLCENGINE_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk
// or
//   OPENAI_API_KEY=... pnpm --filter @harnesskit/examples showcase-sdk

import { denyTools, tokenBudget } from '@harnesskit/policy';
import type { FetchInterceptorOptions } from '@harnesskit/provider-fetch';
import { runAgent } from '@harnesskit/runner';
import { createHarness } from '@harnesskit/sdk';

interface ProviderConfig {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  customHosts?: FetchInterceptorOptions['customHosts'];
}

const provider = (): ProviderConfig => {
  if (process.env.VOLCENGINE_API_KEY) {
    return {
      label: 'volcengine',
      baseUrl: process.env.VOLCENGINE_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: process.env.VOLCENGINE_API_KEY,
      model: process.env.VOLCENGINE_FAST_MODEL ?? 'deepseek-v3-2-251201',
      customHosts: { openai: [process.env.VOLCENGINE_HOST ?? 'ark.cn-beijing.volces.com'] },
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      label: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MINI_MODEL ?? 'gpt-5.4-mini',
    };
  }

  console.error('Set VOLCENGINE_API_KEY or OPENAI_API_KEY to run this real-model showcase.');
  process.exit(1);
};

const main = async (): Promise<void> => {
  const cfg = provider();
  const harness = createHarness({
    policies: [denyTools(['shell']), tokenBudget({ output: 5_000 })],
  });
  let shellActuallyRan = false;

  const tools = harness.wrapTools({
    shell: {
      description: 'Run a shell command. This is intentionally blocked by the harness.',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
      },
      execute: async () => {
        shellActuallyRan = true;
        return 'shell output that should never be produced';
      },
    },
    list_files: {
      description: 'Safely list files in an allowed directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async (args) => {
        const path = String(args.path);
        return path === '/tmp'
          ? 'alpha.log  128B\nnotes.txt  64B\n'
          : `path ${path} is outside the demo allowlist`;
      },
    },
  });

  await harness.startSession({ showcase: 'sdk', provider: cfg.label });
  try {
    const result = await runAgent({
      bus: harness.bus,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      ...(cfg.customHosts ? { customHosts: cfg.customHosts } : {}),
      systemPrompt:
        'You are a tool-using assistant. When the requested tool fails, recover with another available safe tool.',
      prompt:
        'First call shell to list /tmp with sizes. If shell fails, recover by calling list_files for /tmp and summarize the files.',
      tools,
      maxRounds: 5,
    });

    const denied = harness.events.filter((event) => event.type === 'tool.call.denied');
    console.log('=== @harnesskit/sdk real-model showcase ===');
    console.log(`provider: ${cfg.label}, model: ${cfg.model}`);
    console.log(
      `tools used: [${result.toolCalls.map((call) => call.name).join(', ') || '(none)'}]`,
    );
    console.log(`denied events: ${denied.length}`);
    console.log(`shell executor actually ran: ${shellActuallyRan ? 'yes' : 'no'}`);
    console.log(
      `trace events: ${result.trace?.events.length ?? harness.getTrace()?.events.length ?? 0}`,
    );
    console.log(`\nfinal text:\n${result.text}\n`);
  } finally {
    await harness.endSession();
    await harness.dispose();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
