// Demo 8: 10 concurrent agent runs through ONE shared globalThis.fetch
// interceptor. Each gets its own bus + sessionId; verify zero event leakage.
//
// Run: pnpm --filter @harnesskit/examples demo:concurrent

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { TraceRecorder } from '@harnesskit/eval';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const N = 10;

const main = async (): Promise<void> => {
  console.log(`=== Concurrent stress — ${N} agents in parallel through one process ===\n`);
  const t0 = Date.now();

  const tasks = Array.from({ length: N }, (_, i) => ({
    id: i,
    bus: new EventBus(),
  }));

  const results = await Promise.all(
    tasks.map(async ({ id, bus }) => {
      bus.use(new TraceRecorder());
      return runAgent({
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        model: v.fast,
        customHosts: ALL_CUSTOM_HOSTS,
        systemPrompt: 'You answer briefly.',
        prompt: `Say "agent ${id} done" in those exact three words.`,
        bus,
        recorder: false,
        maxRounds: 1,
      });
    }),
  );

  const elapsed = Date.now() - t0;

  // Verify isolation: collect all sessionIds across runs, check uniqueness
  const sessionIds = new Set<string>();
  let leaked = 0;
  for (const r of results) {
    const ids = new Set<string>();
    for (const e of r.events) ids.add(e.ids.sessionId);
    for (const sid of ids) {
      if (sessionIds.has(sid)) leaked++;
      sessionIds.add(sid);
    }
  }

  console.log(`  ${N} concurrent runs completed in ${elapsed}ms`);
  console.log(`  unique sessionIds:  ${sessionIds.size} (expected ${N})`);
  console.log(`  cross-bus leakage:  ${leaked} (expected 0)`);
  console.log('');
  for (const r of results) {
    console.log(
      `  agent ${results.indexOf(r).toString().padStart(2)} → "${r.text.slice(0, 30)}…" (${r.rounds} round)`,
    );
  }
  console.log('');
  if (sessionIds.size === N && leaked === 0) {
    console.log('✓ all agents isolated; events did not bleed across busses');
  } else {
    console.log('✗ isolation broken; investigate');
    process.exit(1);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
