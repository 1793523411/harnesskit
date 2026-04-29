// Showcase: Anthropic Claude on Vertex AI is routed automatically through
// the Anthropic provider. The model id lives in the URL path (Vertex's
// convention) — harnesskit pulls it out for you.
//
// In production, swap the mock target for globalThis.fetch + a Bearer
// token from `google-auth-library`. The interceptor doesn't fetch tokens
// for you.
//
// Run: pnpm --filter @harnesskit/examples showcase-vertex-claude

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const main = async (): Promise<void> => {
  console.log('Showcase: Anthropic Claude on Vertex AI via :rawPredict\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });

  const target = {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // What Vertex would return for Claude:
      const body = {
        id: 'msg_vrtx_demo',
        type: 'message',
        role: 'assistant' as const,
        model: 'claude-sonnet-4@20250514',
        content: [
          { type: 'text', text: 'Got it — running on Vertex.' },
          {
            type: 'tool_use',
            id: 'toolu_v',
            name: 'lookup',
            input: { q: 'Tokyo' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 7 },
      };
      void init;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };

  // No customHosts entry needed — *-aiplatform.googleapis.com is recognized
  // automatically when the path is /publishers/anthropic/models/...:rawPredict.
  const dispose = installFetchInterceptor({ bus, target });

  const url =
    'https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4@20250514:rawPredict';

  console.log(`POST ${url}\n`);

  await target.fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // In production: `Bearer ${await getGcpAccessToken()}`
      authorization: 'Bearer demo-gcp-token',
    },
    body: JSON.stringify({
      anthropic_version: 'vertex-2023-10-16',
      max_tokens: 256,
      tools: [
        {
          name: 'lookup',
          input_schema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
      messages: [{ role: 'user', content: 'Look up Tokyo' }],
      // Notice: NO `model` field. Vertex Claude puts the model in the URL.
    }),
  });
  dispose();

  const turnStart = events.find((e) => e.type === 'turn.start');
  const turnEnd = events.find((e) => e.type === 'turn.end');
  const tool = events.find((e) => e.type === 'tool.call.requested');
  const usage = events.find((e) => e.type === 'usage');

  if (turnStart?.type === 'turn.start') {
    console.log('turn.start:');
    console.log(`  provider:     ${turnStart.provider}`);
    console.log(`  model:        ${turnStart.model} (extracted from URL path)`);
    console.log(`  request msgs: ${turnStart.request.messages.length}`);
    console.log(
      `  request tools: ${turnStart.request.tools?.map((t) => t.name).join(', ') ?? 'none'}`,
    );
  }
  if (turnEnd?.type === 'turn.end') {
    const text = turnEnd.response?.content
      ?.filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    console.log(`\nturn.end:`);
    console.log(`  text reply: "${text}"`);
  }
  if (tool?.type === 'tool.call.requested') {
    console.log(`\ntool.call.requested:`);
    console.log(`  ${tool.call.name}(${JSON.stringify(tool.call.input)})`);
  }
  if (usage?.type === 'usage') {
    console.log(`\nusage: input=${usage.usage.inputTokens} output=${usage.usage.outputTokens}`);
  }
  console.log(
    '\n✓ Same provider tag (anthropic) — every interceptor / policy / recorder works as-is.',
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
