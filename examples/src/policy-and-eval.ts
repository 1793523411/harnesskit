// Full demo: policy stack + trace recording + scoring.
// Run: pnpm --filter @harnesskit/examples policy-and-eval

import { EventBus } from '@harnesskit/core';
import {
  TraceRecorder,
  deniedRatio,
  errorCount,
  scoreTrace,
  toolCallCount,
  totalTokens,
  turnCount,
} from '@harnesskit/eval';
import { policy, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { callAnthropic, makeMockTarget } from './_mock.js';

const main = async () => {
  const bus = new EventBus();

  // Compose multiple constraints into one policy
  const guard = policy()
    .denyTools(['shell', 'exec_*'])
    .allowTools(['read_*', '*_file'])
    .tokenBudget({ total: 200 })
    .maxToolCalls(5)
    .build('demo-policy');

  bus.use(policyToInterceptor(guard));

  // Record everything for later analysis
  const recorder = new TraceRecorder();
  bus.use(recorder);

  // Drive the mock SDK through three turns
  const target = makeMockTarget();
  const dispose = installFetchInterceptor({ bus, target });

  await callAnthropic(target, [{ role: 'user', content: 'show /etc/hostname' }]);
  await callAnthropic(target, [
    { role: 'user', content: 'show /etc/hostname' },
    { role: 'assistant', content: 'tried shell, got blocked' },
    { role: 'user', content: 'try read_file instead' },
  ]);
  await callAnthropic(target, [
    { role: 'user', content: 'show /etc/hostname' },
    { role: 'assistant', content: 'read it' },
    { role: 'user', content: 'thanks' },
  ]);

  dispose();

  // Score the captured trace
  const traces = recorder.allTraces();
  console.log(`recorded ${traces.length} session(s)`);
  for (const trace of traces) {
    console.log(`\nsession: ${trace.sessionId}`);
    console.log(`  events: ${trace.events.length}`);
    const results = await scoreTrace(trace, [
      toolCallCount(),
      deniedRatio(),
      totalTokens(),
      turnCount(),
      errorCount(),
    ]);
    for (const r of results) console.log(`  ${r.scorerId.padEnd(20)} = ${r.value}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
