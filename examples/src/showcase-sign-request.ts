// Showcase: signRequest hook. The harness gives you the *final* serialized
// body and lets you compute auth headers (e.g. AWS Sig V4 for Bedrock,
// HMAC for self-hosted gateways). Headers you return are merged in.
//
// This demo uses a stub HMAC signer; in production swap it for `aws4fetch`
// or `@aws-sdk/signature-v4`.
//
// Run: pnpm --filter @harnesskit/examples showcase-sign-request

import { createHash, createHmac } from 'node:crypto';
import { EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, s: string): string => createHmac('sha256', key).update(s).digest('hex');

const main = async (): Promise<void> => {
  console.log('Showcase: signRequest hook (stub HMAC signer)\n');

  const bus = new EventBus();
  let observedHeaders: Record<string, string> = {};
  let signerInvocations = 0;

  const target = {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
      return new Response(
        JSON.stringify({
          id: 'msg_signed',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'authorized' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };

  const dispose = installFetchInterceptor({
    bus,
    target,
    signRequest: async ({ url, method, headers, body, provider }) => {
      signerInvocations++;
      const stamp = '20260429T010203Z';
      const bodyHash = sha256(body);
      const stringToSign = [method, url, stamp, headers.get('content-type') ?? '', bodyHash].join('\n');
      const signature = hmac('demo-secret-key', stringToSign);
      console.log(`[signer] invoked for provider=${provider}`);
      console.log(`[signer]   url:     ${url}`);
      console.log(`[signer]   method:  ${method}`);
      console.log(`[signer]   bodyHash:${bodyHash.slice(0, 16)}…`);
      console.log(`[signer]   sig:     ${signature.slice(0, 16)}…`);
      return {
        headers: {
          authorization: `HSIG demo-key-id Signature=${signature}`,
          'x-amz-date': stamp,
          'x-amz-content-sha256': bodyHash,
        },
      };
    },
  });

  // To make this Bedrock-flavored, you'd register the Bedrock host via
  // `customHosts.anthropic` and a future Bedrock detector. For the showcase
  // we hit api.anthropic.com so the existing detector takes over and the
  // signer actually runs.
  await target.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-original': 'preserved' },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  dispose();

  console.log('\nFinal headers received by upstream fetch:');
  for (const [k, v] of Object.entries(observedHeaders)) {
    console.log(`  ${k}: ${v.length > 60 ? `${v.slice(0, 56)}…` : v}`);
  }
  console.log(`\n✓ signer ran ${signerInvocations}× — auth headers injected, original headers kept.`);
  console.log('  Swap the stub for `aws4fetch` to make this Bedrock-compatible end-to-end.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
