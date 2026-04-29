// Demo 11: code-generation model with a write_file tool. The model writes
// TypeScript code; argRegex policy ensures the file path stays under ./out.
// Demonstrates: code model + harness + path validation policy.
//
// Run: pnpm --filter @harnesskit/examples demo:codex

import { argRegex } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const writtenFiles = new Map<string, string>();

const main = async (): Promise<void> => {
  console.log('=== Codex: doubao-code-preview writes TypeScript with path-allowlist ===\n');

  const result = await runAgent({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.code, // doubao-seed-2-0-code-preview
    customHosts: ALL_CUSTOM_HOSTS,

    systemPrompt:
      'You are a TypeScript expert. Use the `write_file` tool to write the requested code. Files MUST go under ./out/. Then reply with one short sentence describing what you did.',
    prompt:
      'Write a TypeScript function `fibonacci(n: number): number` to ./out/fib.ts. Use memoization.',

    tools: {
      write_file: {
        description: 'Write a file to disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
        execute: async (args: Record<string, unknown>) => {
          const path = String(args.path);
          const content = String(args.content);
          writtenFiles.set(path, content);
          return `wrote ${content.length} bytes to ${path}`;
        },
      },
    },

    // Policy: write_file's path arg must start with ./out/ (or out/)
    policies: [
      argRegex({
        tool: 'write_file',
        argPath: 'path',
        regex: /^\.?\/?out\//,
        description: 'write_file paths must be under ./out/',
      }),
    ],

    maxRounds: 3,
  });

  console.log(`rounds:  ${result.rounds}`);
  console.log(`tools:   [${result.toolCalls.map((c) => c.name).join(', ')}]`);
  console.log(`denied:  ${result.events.filter((e) => e.type === 'tool.call.denied').length}`);
  console.log(`\nfinal:   ${result.text}\n`);

  if (writtenFiles.size > 0) {
    console.log('files (in-memory, not actually written to disk):');
    for (const [path, content] of writtenFiles) {
      console.log(`\n--- ${path} (${content.length} bytes) ---`);
      console.log(content.slice(0, 600));
      if (content.length > 600) console.log('…');
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
