// Showcase: createDiagnostic — answers "why is my harness silent?" in one
// printout. Two scenarios:
//   1. Forgot to call installFetchInterceptor → fetchPatched=false, clear
//      recommendation to fix.
//   2. Correctly installed but URL doesn't match a known provider host →
//      patched but turns=0, recommendation to add to customHosts.
//
// Run: pnpm --filter @harnesskit/examples showcase-diagnostic

import { EventBus } from '@harnesskit/core';
import { createDiagnostic, installFetchInterceptor } from '@harnesskit/provider-fetch';

const mockJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const noopAnthropicResponse = () =>
  mockJson({
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 1 },
  });

const main = async (): Promise<void> => {
  console.log('Showcase: createDiagnostic — three setups, three reports.\n');

  /* Scenario 1: forgot installFetchInterceptor */
  console.log('═══ Scenario 1: forgot to call installFetchInterceptor ═══');
  {
    const bus = new EventBus();
    const target = { fetch: noopAnthropicResponse as unknown as typeof fetch };
    const diag = createDiagnostic({ bus, target });
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    });
    console.log(diag.format());
    diag.dispose();
  }

  /* Scenario 2: installed, but URL host isn't a known provider */
  console.log('\n═══ Scenario 2: patched, but URL hits a custom proxy you forgot to register ═══');
  {
    const bus = new EventBus();
    const target = { fetch: noopAnthropicResponse as unknown as typeof fetch };
    const diag = createDiagnostic({ bus, target });
    const dispose = installFetchInterceptor({ bus, target });
    // Will pass through unintercepted because llm-gateway.local isn't in
    // any default host list.
    await target.fetch('https://llm-gateway.local/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    console.log(diag.format());
    dispose();
    diag.dispose();
  }

  /* Scenario 3: correctly configured */
  console.log('\n═══ Scenario 3: correctly configured ═══');
  {
    const bus = new EventBus();
    const target = { fetch: noopAnthropicResponse as unknown as typeof fetch };
    const diag = createDiagnostic({ bus, target });
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    console.log(diag.format());
    dispose();
    diag.dispose();
  }

  console.log(
    '\n✓ Drop createDiagnostic({ bus }) above your code while debugging — answers in seconds why the bus is quiet.',
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
