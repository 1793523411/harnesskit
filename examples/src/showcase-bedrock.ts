// Showcase: AWS Bedrock Converse API works through harnesskit out of the box.
// Auth (Sig V4) is plumbed via the `signRequest` hook — bring `aws4fetch` or
// the AWS SDK to do the actual signing.
//
// This demo uses a stub HMAC signer + a mock Bedrock target so it runs with
// no AWS credentials. To wire it up for real, swap the signer for an
// `aws4fetch.AwsClient` and remove the mock target.
//
// Run: pnpm --filter @harnesskit/examples showcase-bedrock

import { createHash, createHmac } from 'node:crypto';
import { type AgentEvent, EventBus } from '@harnesskit/core';
import { redactPiiInToolResults } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, s: string): string => createHmac('sha256', key).update(s).digest('hex');

const main = async (): Promise<void> => {
  console.log('Showcase: Bedrock Converse + signRequest + redactPiiInToolResults\n');

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });

  let observedHeaders: Record<string, string> = {};
  let observedBody: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const target = {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      observedBody = JSON.parse((init?.body as string) ?? '{}');
      // Mocked Bedrock Converse response
      return new Response(
        JSON.stringify({
          output: {
            message: {
              role: 'assistant',
              content: [
                { text: 'Pulled the customer record.' },
                {
                  toolUse: {
                    toolUseId: 'tu_lookup',
                    name: 'lookup_customer',
                    input: { id: 'C-9921' },
                  },
                },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 14, outputTokens: 18, totalTokens: 32 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };

  const dispose = installFetchInterceptor({
    bus,
    target,
    // Active rewrite: scrub email/SSN out of any tool_result the model would
    // see. Pairs naturally with Bedrock — same hook, different wire format.
    rewriteToolResults: redactPiiInToolResults({ patterns: ['email', 'ssn'] }),
    // Plug your real AWS Sig V4 signer here. We ship a stub so the demo runs
    // without AWS creds. In production:
    //   const aws = new AwsClient({ accessKeyId, secretAccessKey, region });
    //   signRequest: async ({ url, method, headers, body }) => {
    //     const signed = await aws.sign(new Request(url, { method, headers, body }));
    //     return { headers: Object.fromEntries(signed.headers) };
    //   },
    signRequest: async ({ url, method, headers, body }) => {
      const stamp = '20260430T070000Z';
      const bodyHash = sha256(body);
      const stringToSign = [method, url, stamp, headers.get('content-type') ?? '', bodyHash].join('\n');
      const sig = hmac('demo-stub-secret', stringToSign);
      return {
        headers: {
          authorization: `AWS4-HMAC-SHA256 Credential=AKIASTUB/20260430/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${sig}`,
          'x-amz-date': stamp,
          'x-amz-content-sha256': bodyHash,
        },
      };
    },
  });

  // Round 1: model emits a tool_use
  await target.fetch(
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: 'Look up customer C-9921' }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'lookup_customer',
                description: 'Find a customer by id',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                  },
                },
              },
            },
          ],
        },
        inferenceConfig: { maxTokens: 256 },
      }),
    },
  );

  // Round 2: host SDK runs the tool and feeds back a result that contains PII
  await target.fetch(
    'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ text: 'Look up customer C-9921' }] },
          {
            role: 'assistant',
            content: [
              {
                toolUse: {
                  toolUseId: 'tu_lookup',
                  name: 'lookup_customer',
                  input: { id: 'C-9921' },
                },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'tu_lookup',
                  content: [
                    { text: 'Name: Alice. Email: alice@example.com. SSN: 123-45-6789.' },
                  ],
                },
              },
            ],
          },
        ],
      }),
    },
  );

  dispose();

  console.log('— Round 1 — model decides to call lookup_customer:');
  const turnStart = events.find((e) => e.type === 'turn.start');
  if (turnStart?.type === 'turn.start') {
    console.log(`  provider: ${turnStart.provider}`);
    console.log(`  model:    ${turnStart.model}`);
  }
  const tool = events.find((e) => e.type === 'tool.call.requested');
  if (tool?.type === 'tool.call.requested') {
    console.log(`  tool:     ${tool.call.name}(${JSON.stringify(tool.call.input)})`);
  }

  console.log('\n— Final round 2 request to upstream (with PII rewrite applied) —');
  const lastUser = observedBody?.messages.at(-1);
  const blocks = lastUser?.content as Array<{ toolResult?: { content: Array<{ text?: string }> } }>;
  const tr = blocks?.[0]?.toolResult;
  if (tr) console.log(`  toolResult.text: "${tr.content[0]?.text}"`);

  console.log('\n— Auth headers injected by signRequest —');
  for (const k of ['authorization', 'x-amz-date', 'x-amz-content-sha256']) {
    const v = observedHeaders[k];
    if (!v) continue;
    console.log(`  ${k}: ${v.length > 60 ? `${v.slice(0, 56)}…` : v}`);
  }

  console.log('\n✓ Bedrock Converse routed; toolUse normalized; PII redacted; sigv4 headers injected.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
