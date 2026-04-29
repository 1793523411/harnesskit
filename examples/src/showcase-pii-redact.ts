// Showcase: actively scrub PII out of tool_result content before the model
// sees it. Pairs with `piiScan` (input gating) to cover both directions.
//
// Setup is mock-only: we run two requests through the same harness — one
// without `rewriteToolResults`, one with — and inspect what reached the wire.
// Run: pnpm --filter @harnesskit/examples showcase-pii-redact

import { EventBus } from '@harnesskit/core';
import { redactPiiInToolResults } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const dirtyToolResult = `Lookup result:
- Name: Alice Park
- Email: alice.park@example.com
- SSN: 123-45-6789
- Phone: (415) 555-0142
- Notes: VIP customer, comp her next order.`;

const buildRequest = () => ({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Look up customer "alice.park"' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_lookup',
          name: 'lookup_customer',
          input: { username: 'alice.park' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_lookup',
          content: dirtyToolResult,
        },
      ],
    },
  ],
});

const captureOutgoing = (): {
  target: { fetch: typeof fetch };
  read: () => unknown;
} => {
  let captured: unknown;
  const target = {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse((init?.body as string) ?? '{}');
      const reply = {
        id: 'msg_redact_demo',
        type: 'message',
        role: 'assistant' as const,
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'noted' }],
        stop_reason: 'end_turn',
      };
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
  return { target, read: () => captured };
};

const formatToolResult = (req: unknown): string => {
  const messages = (req as { messages: Array<{ role: string; content: unknown }> }).messages;
  const last = messages.at(-1);
  const blocks = last?.content as Array<{ type: string; content: unknown }>;
  const tr = blocks.find((b) => b.type === 'tool_result');
  if (!tr) return '<no tool_result>';
  if (typeof tr.content === 'string') return tr.content;
  // Anthropic multipart shape — pull text out
  const parts = tr.content as Array<{ type?: string; text?: string }>;
  return parts.map((p) => p.text ?? '').join('\n');
};

const run = async (label: string, withRewriter: boolean): Promise<unknown> => {
  const bus = new EventBus();
  const { target, read } = captureOutgoing();
  const dispose = installFetchInterceptor({
    bus,
    target,
    ...(withRewriter
      ? {
          rewriteToolResults: redactPiiInToolResults({
            patterns: ['email', 'ssn', 'phone'],
            replacement: '[REDACTED]',
          }),
        }
      : {}),
  });

  await target.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildRequest()),
  });
  dispose();

  const captured = read();
  console.log(`\n── ${label} ──`);
  console.log(formatToolResult(captured));
  return captured;
};

const main = async (): Promise<void> => {
  console.log('Showcase: active PII redaction in tool_result content\n');
  console.log('Original tool output (raw):');
  console.log(dirtyToolResult);
  await run('Without redactPiiInToolResults — what the model would see', false);
  await run('With redactPiiInToolResults({ patterns: email, ssn, phone })', true);
  console.log('\n✓ Wire-level rewrite — the model never sees the redacted fields.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
