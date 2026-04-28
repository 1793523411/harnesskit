// OpenAI variant of quickstart.ts — same policy code, different provider.
// Demonstrates that one policy + interceptor works across providers.
// Run: pnpm --filter @harnesskit/examples openai-quickstart

import { EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const main = async () => {
  const bus = new EventBus();

  bus.use({
    name: 'logger',
    on: (e) => {
      const tag = `[${e.source}] ${e.type}`;
      const detail =
        e.type === 'tool.call.requested'
          ? `${e.call.name}(${JSON.stringify(e.call.input)})`
          : e.type === 'tool.call.denied'
            ? `${e.call.name} -> ${e.reason}`
            : e.type === 'usage'
              ? `in=${e.usage.inputTokens} out=${e.usage.outputTokens}`
              : '';
      console.log(`  ${tag.padEnd(36)} ${detail}`);
    },
  });

  // Same policy declaration as the Anthropic quickstart — provider-agnostic.
  bus.use(policyToInterceptor(denyTools(['shell'])));

  const target = {
    fetch: async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl_demo',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_demo',
                    type: 'function',
                    function: { name: 'shell', arguments: '{"cmd":"ls /etc"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  };

  const dispose = installFetchInterceptor({ bus, target });

  console.log('--- OpenAI Chat Completions: model wants shell, policy denies ---');
  await target.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'list /etc' }],
    }),
  });

  dispose();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
