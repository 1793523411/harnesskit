// Quickstart: install the fetch interceptor, deny one tool, see events stream by.
// Run: pnpm --filter @harnesskit/examples quickstart

import { EventBus } from '@harnesskit/core';
import { denyTools, policyToInterceptor } from '@harnesskit/policy';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { callAnthropic, makeMockTarget } from './_mock.js';

const main = async () => {
  const bus = new EventBus();

  // Print every event the bus sees
  bus.use({
    name: 'logger',
    on: (e) => {
      const tag = `[${e.source}] ${e.type}`;
      const detail =
        e.type === 'tool.call.requested'
          ? `${e.call.name}(${JSON.stringify(e.call.input)})`
          : e.type === 'tool.call.denied'
            ? `${e.call.name} -> ${e.reason}`
            : e.type === 'usage'
              ? `in=${e.usage.inputTokens} out=${e.usage.outputTokens}`
              : '';
      console.log(`  ${tag.padEnd(36)} ${detail}`);
    },
  });

  // Block any tool named "shell"
  bus.use(policyToInterceptor(denyTools(['shell'])));

  // Install the L1 interceptor on a mock target (in real code: omit `target`
  // to patch globalThis.fetch instead)
  const target = makeMockTarget();
  const dispose = installFetchInterceptor({ bus, target });

  console.log('--- turn 1: model wants to run shell ---');
  await callAnthropic(target, [{ role: 'user', content: 'list /etc' }]);

  dispose();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
