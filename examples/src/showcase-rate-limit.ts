// Showcase: rate limit policy. Sliding-window cap on tokens-per-minute and
// requests-per-minute. Once the window's saturated, the next tool call is
// denied so the agent loop stops issuing more API calls.
//
// Run: pnpm --filter @harnesskit/examples showcase-rate-limit

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { policyToInterceptor, rateLimit } from '@harnesskit/policy';

const ids = { sessionId: 's1', turnId: 't1' };

const turnStart = (ts: number): AgentEvent => ({
  type: 'turn.start',
  ts,
  ids,
  source: 'l1',
  provider: 'openai',
  model: 'gpt-4o',
  request: { messages: [] },
});

const usageEvt = (ts: number, input: number, output: number): AgentEvent => ({
  type: 'usage',
  ts,
  ids,
  source: 'l1',
  usage: { inputTokens: input, outputTokens: output },
});

const toolReq = (ts: number, name = 'shell'): AgentEvent => ({
  type: 'tool.call.requested',
  ts,
  ids: { ...ids, callId: `tc_${ts}` },
  source: 'l1',
  call: { id: `tc_${ts}`, name, input: { cmd: 'echo hi' } },
});

const main = async (): Promise<void> => {
  console.log('Showcase: rateLimit({ tokensPerMin: 1500, requestsPerMin: 4 })\n');

  let clock = 1_000_000;
  const tick = (ms: number) => {
    clock += ms;
  };

  const bus = new EventBus();
  bus.use(
    policyToInterceptor(
      rateLimit({
        tokensPerMin: 1500,
        requestsPerMin: 4,
        now: () => clock,
      }),
    ),
  );

  // Count denials from bus.emit results — tool.call.denied events are emitted
  // by the wire layer (provider-fetch), not the bus on its own. In a real
  // setup with installFetchInterceptor those events appear automatically.
  const denials: string[] = [];
  const tryCall = async (label: string) => {
    const r = await bus.emit(toolReq(clock));
    if (r.denied) denials.push(`${label} — ${r.denied.reason}`);
    console.log(`  tool.call.requested → ${r.denied ? 'DENIED — ' + r.denied.reason : 'allow'}`);
  };

  console.log('Round 1 — 600 input + 200 output tokens (running total: 800).');
  await bus.emit(turnStart(clock));
  await bus.emit(usageEvt(clock, 600, 200));
  await tryCall('round 1');

  tick(2000);

  console.log('Round 2 — 400 input + 300 output (running total: 1500).');
  await bus.emit(turnStart(clock));
  await bus.emit(usageEvt(clock, 400, 300));
  await tryCall('round 2');

  tick(2000);

  console.log('\nRound 3 — try again immediately. Should be DENIED (still inside the window).');
  await bus.emit(turnStart(clock));
  await tryCall('round 3');

  console.log('\n... wait 61 seconds (sliding window expires) ...');
  tick(61_000);

  console.log('\nRound 4 — after the window rolls past, the cap resets.');
  await tryCall('round 4');

  console.log(`\n${denials.length} denial(s) recorded:`);
  for (const d of denials) console.log(`  ${d}`);

  console.log('\n✓ Throttle is per-bus; reset by waiting out the window or starting a new bus.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
