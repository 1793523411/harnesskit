// Demo 10: 200K-context model summarizing a long document. Generates a
// synthetic ~50KB doc inline, feeds it through DeepSeek-v3 (via Volcengine,
// 200K context), and asks for a summary. Watches token usage + duration.
//
// Run: pnpm --filter @harnesskit/examples demo:long-context

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

const generateDoc = (sections: number): string => {
  const lines: string[] = [];
  for (let i = 0; i < sections; i++) {
    lines.push(`## Section ${i + 1}: Quarterly Report`);
    lines.push('');
    lines.push(
      `In Q${(i % 4) + 1} of 2026, the operations team reported revenue of $${
        12_000_000 + i * 100_000
      } across ${5 + (i % 8)} business units. ` +
        `Major investments included infrastructure upgrades ($${
          800_000 + (i % 5) * 50_000
        }), staff onboarding (${20 + (i % 12)} engineers), and product launches (${
          1 + (i % 3)
        } new SKUs).`,
    );
    lines.push(
      `Customer satisfaction surveys returned an NPS of ${50 + (i % 20)}, with the top complaints centered on documentation completeness and onboarding latency. The team committed to addressing both in the following quarter.`,
    );
    lines.push('');
    lines.push(
      `Risk factors: dependency on a single cloud vendor (${
        i % 2 === 0 ? 'AWS' : 'GCP'
      }), supply chain volatility for hardware (${
        i % 3 === 0 ? 'GPUs' : i % 3 === 1 ? 'storage' : 'networking'
      }), and regulatory uncertainty in jurisdictions ${i % 5 === 0 ? 'EU' : 'US'} and ${
        i % 7 === 0 ? 'APAC' : 'LATAM'
      }.`,
    );
    lines.push('');
  }
  return lines.join('\n');
};

const main = async (): Promise<void> => {
  console.log('=== Long context: 200K-context model summarizing a 50KB doc ===\n');

  const doc = generateDoc(180); // ~50KB

  console.log(
    `document size: ${doc.length.toLocaleString()} chars (~${Math.round(doc.length / 4).toLocaleString()} tokens)`,
  );

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  const dispose = installFetchInterceptor({ bus, customHosts: ALL_CUSTOM_HOSTS });

  const t0 = Date.now();
  const res = await fetch(`${v.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${v.apiKey}`,
    },
    body: JSON.stringify({
      model: v.fast,
      messages: [
        {
          role: 'system',
          content: 'Summarize documents concisely. Include 3-5 key bullet points.',
        },
        {
          role: 'user',
          content: `Summarize this quarterly report compilation in 5 bullets:\n\n${doc}`,
        },
      ],
      max_tokens: 800,
    }),
  });
  const json = (await res.json()) as {
    choices: Array<{ message: { content?: string } }>;
  };
  const durationMs = Date.now() - t0;
  dispose();

  const usage = events.find((e) => e.type === 'usage');
  console.log(`duration:    ${durationMs}ms`);
  if (usage?.type === 'usage') {
    console.log(
      `tokens:      in=${usage.usage.inputTokens?.toLocaleString()} out=${usage.usage.outputTokens?.toLocaleString()}`,
    );
  }
  console.log('\nsummary:');
  console.log(json.choices[0]?.message.content ?? '(no content)');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
