// Showcase: harnesskit confines outbound fetch to allow-listed hosts.
// Run: VOLCENGINE_API_KEY=… pnpm --filter @harnesskit/examples showcase-hostname

import { hostnameAllowlist } from '@harnesskit/policy';
import { type ChatTool, printShowcase, runBaselineVsGuarded } from './_showcase-shared.js';

const tools: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'http_get',
      description: 'Fetch the body of a URL',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

const fakeExecute = (_name: string, args: Record<string, unknown>): string => {
  const url = String(args.url ?? '');
  return `(host pretends GET ${url} returned 200 with 4KB body)`;
};

const main = async (): Promise<void> => {
  const { baseline, guarded } = await runBaselineVsGuarded({
    title: 'Hostname allowlist — only Wikipedia is reachable',
    systemPrompt:
      'You research questions on the open web using the http_get tool. Pick the best source for each fact.',
    userPrompt:
      'What is the current population of Tokyo, the GDP of Japan, and the meaning of "ukiyo-e"? Use http_get on whichever sources you think reliable.',
    tools,
    fakeExecute,
    policies: () => [
      hostnameAllowlist({ tool: 'http_get', argPath: 'url', hosts: ['en.wikipedia.org'] }),
    ],
    maxRounds: 10,
  });

  const notes: string[] = [];
  if (guarded.denialCount > 0) {
    notes.push(`✓ ${guarded.denialCount} non-Wikipedia URL(s) blocked by hostnameAllowlist`);
  }
  printShowcase('Hostname allowlist', baseline, guarded, notes);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
