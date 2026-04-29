// Showcase: chain multiple tool-result rewriters. Each stage scrubs a
// different class of leak. A thrown rewriter is caught and logged, the
// downstream ones still run.
//
// Run: pnpm --filter @harnesskit/examples showcase-rewriter-chain

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { redactPiiInToolResults } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';

const TOOL_OUTPUT = `Customer profile:
- Name: Alice Park
- Email: alice.park@example.com
- SSN: 123-45-6789
- Internal note: API_KEY=sk-live-AbCdEf012345 (rotate before sharing)
- Bug ID: BUG-7421`;

const captureOutgoing = () => {
  let captured: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const target = {
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'noted' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  };
  return { target, read: () => captured };
};

const sendOnce = async (
  rewriters?: Parameters<typeof installFetchInterceptor>[0]['rewriteToolResults'],
): Promise<{
  delivered: string;
  errors: AgentEvent[];
}> => {
  const bus = new EventBus();
  const errors: AgentEvent[] = [];
  bus.use({
    on: (e) => {
      if (e.type === 'error') errors.push(e);
    },
  });
  const { target, read } = captureOutgoing();
  const dispose = installFetchInterceptor({
    bus,
    target,
    ...(rewriters ? { rewriteToolResults: rewriters } : {}),
  });
  await target.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_lookup',
              content: TOOL_OUTPUT,
            },
          ],
        },
      ],
    }),
  });
  await new Promise((r) => setTimeout(r, 5));
  dispose();
  const captured = read();
  const last = captured?.messages.at(-1);
  const blocks = last?.content as Array<{ content: unknown }>;
  const delivered =
    typeof blocks[0]?.content === 'string'
      ? (blocks[0]?.content as string)
      : JSON.stringify(blocks[0]?.content);
  return { delivered, errors };
};

const main = async (): Promise<void> => {
  console.log('Showcase: chained rewriteToolResults\n');
  console.log('Original tool output:');
  console.log(TOOL_OUTPUT);
  console.log('\n──────────────────────────────────────────\n');

  // Pipeline 1: PII redactor + secret scrubber + bug-id pseudonymizer.
  // The middle one demonstrates throw-handling — it bombs on every input.
  const seenBugAudit: string[] = [];
  const pipeline = [
    redactPiiInToolResults({
      patterns: ['email', 'ssn'],
      audit: ({ matches }) => {
        for (const m of matches) seenBugAudit.push(`pii:${m.pattern}=${m.matched.join(',')}`);
      },
    }),
    (content: string): string => content.replace(/sk-live-[A-Za-z0-9]+/g, '[API_KEY_REVOKED]'),
    (_content: string): string | undefined => {
      throw new Error('demo: rewriter #3 explodes');
    },
    (content: string): string =>
      content.replace(/\bBUG-\d+\b/g, (id) => {
        seenBugAudit.push(`bugid:${id}`);
        return 'BUG-#####';
      }),
  ];

  const { delivered, errors } = await sendOnce(pipeline);
  console.log('Sent to model after chain:');
  console.log(delivered);
  console.log('\nErrors emitted (caught from throwing rewriter):');
  for (const e of errors) {
    if (e.type === 'error') console.log(`  - [${e.stage}] ${e.message}`);
  }
  console.log('\nAudit log:');
  for (const a of seenBugAudit) console.log(`  ${a}`);
  console.log('\n✓ Each stage runs in order. A thrown rewriter is caught and logged; the rest of');
  console.log('  the chain still runs. Audit hooks fire only on real matches.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
