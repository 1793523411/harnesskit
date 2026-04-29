// Showcase: 2 concurrent tenants in the same Node process, each with its own
// bus + policies. Tenant A allows file reads but bans shell; Tenant B allows
// shell but bans network fetches. Both run the same prompt in parallel.
// Run: VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase-multi-tenant

import { EventBus } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';

const API_KEY = process.env.VOLCENGINE_API_KEY;
if (!API_KEY) {
  console.error('Set VOLCENGINE_API_KEY to run this showcase.');
  process.exit(1);
}

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = 'deepseek-v3-2-251201';

const tools = {
  shell: {
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    },
    execute: async (args: Record<string, unknown>) =>
      `(host pretends \`${String(args.cmd)}\` ran, returned 3 lines)`,
  },
  fetch: {
    description: 'HTTP GET a URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    execute: async (args: Record<string, unknown>) =>
      `(host pretends GET ${String(args.url)} returned 200 with 4KB body)`,
  },
  read_file: {
    description: 'Read a local file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    execute: async (args: Record<string, unknown>) =>
      `(host pretends ${String(args.path)} contains: hello world)`,
  },
};

const TENANTS = [
  {
    id: 'tenant-A',
    description: 'Strict: no shell',
    bus: () => {
      const bus = new EventBus();
      bus.use(policyToInterceptor(denyTools(['shell'])));
      bus.use(new TraceRecorder());
      return bus;
    },
  },
  {
    id: 'tenant-B',
    description: 'Different policy: no fetch',
    bus: () => {
      const bus = new EventBus();
      bus.use(policyToInterceptor(denyTools(['fetch'])));
      bus.use(new TraceRecorder());
      return bus;
    },
  },
];

const PROMPT =
  'You have these tools: shell, fetch, read_file. To answer, use whichever is most appropriate. Prompt: read /etc/hosts and tell me what is in it.';

const main = async (): Promise<void> => {
  console.log('=== Multi-tenant: 2 concurrent agents, different policies, isolated buses ===');

  const runs = TENANTS.map(async (tenant) => {
    const bus = tenant.bus();
    const result = await runAgent({
      baseUrl: BASE_URL,
      apiKey: API_KEY!,
      model: MODEL,
      systemPrompt: 'You help users gather info. Pick whichever tool best fits.',
      prompt: PROMPT,
      tools,
      bus,
      customHosts: { openai: ['ark.cn-beijing.volces.com'] },
      maxRounds: 5,
    });
    return { tenant, result };
  });

  const settled = await Promise.all(runs);

  console.log('\n── side-by-side ──');
  for (const { tenant, result } of settled) {
    console.log(`\n[${tenant.id}] ${tenant.description}`);
    console.log(`  tools used: [${result.toolCalls.map((c) => c.name).join(', ') || '(none)'}]`);
    const denied = result.events.filter((e) => e.type === 'tool.call.denied').length;
    console.log(`  rounds: ${result.rounds}  denied: ${denied}`);
    console.log(`  final: ${result.text.slice(0, 120)}…`);
  }

  // Verify isolation
  const tenantATrace = settled[0]!.result.trace;
  const tenantBTrace = settled[1]!.result.trace;
  const idsA = new Set(tenantATrace?.events.map((e) => e.ids.sessionId));
  const idsB = new Set(tenantBTrace?.events.map((e) => e.ids.sessionId));
  const overlap = [...idsA].filter((id) => idsB.has(id));
  if (overlap.length === 0 && idsA.size > 0 && idsB.size > 0) {
    console.log('\n✓ tenant traces are fully isolated — no overlapping sessionIds');
  } else {
    console.log(`\n× tenant trace isolation broken: ${overlap.length} overlap`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
