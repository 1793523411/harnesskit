// Capture-then-replay demo: record a trace under loose policy, then replay it
// through a stricter policy to see what would have been denied.
// Run: pnpm --filter @harnesskit/examples replay-eval

import { EventBus } from '@harnesskit/core';
import { TraceRecorder, replayTrace, traceFromJson, traceToJson } from '@harnesskit/eval';
import { allowTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { callAnthropic, makeMockTarget } from './_mock.js';

const main = async () => {
  // ── Phase 1: capture under a loose policy ─────────────────────────────
  const captureBus = new EventBus();
  const recorder = new TraceRecorder();
  captureBus.use(recorder);

  const target = makeMockTarget();
  const dispose = installFetchInterceptor({ bus: captureBus, target });
  await callAnthropic(target, [{ role: 'user', content: 'task' }]);
  dispose();

  const trace = recorder.allTraces()[0];
  if (!trace) throw new Error('expected at least one trace');

  // ── Phase 1.5: round-trip through JSON to prove serialization works ───
  const json = traceToJson(trace);
  const loaded = traceFromJson(json);
  console.log(`captured trace: ${loaded.events.length} events, ${json.length} bytes JSON`);

  // ── Phase 2: replay through a strict policy ───────────────────────────
  const strictBus = new EventBus();
  // Allow ONLY read_file. Anything else (including shell) gets denied.
  strictBus.use(policyToInterceptor(allowTools(['read_file'])));

  const result = await replayTrace(loaded, strictBus);
  console.log(`\nstrict-policy replay: ${result.denials.length} denial(s)`);
  for (const d of result.denials) {
    if (d.event.type === 'tool.call.requested') {
      console.log(`  - ${d.event.call.name}: ${d.reason}`);
    }
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
