// Demo 9: multimodal image input. Sends a public image URL to Doubao Pro and
// asks for a description. Verifies the harness emits standard events even
// with non-text input parts.
//
// Run: pnpm --filter @harnesskit/examples demo:image

import { type AgentEvent, EventBus } from '@harnesskit/core';
import { installFetchInterceptor } from '@harnesskit/provider-fetch';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

// Inline base64 — avoids the upstream provider's image-fetcher having to
// reach external hosts. This is a 16x16 solid red PNG; the model should
// describe it as a red square / colored block / similar.
const IMAGE_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mP8z8DwHwAFBQH/q8XXkAAAAABJRU5ErkJggg==';

const main = async (): Promise<void> => {
  console.log('=== Multimodal: Doubao with image input ===\n');
  console.log(`Image: ${IMAGE_URL}\n`);

  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  const dispose = installFetchInterceptor({ bus, customHosts: ALL_CUSTOM_HOSTS });

  const res = await fetch(`${v.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${v.apiKey}`,
    },
    body: JSON.stringify({
      model: v.reasoning, // doubao-pro supports text + image
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What animal is in this image? One sentence.' },
            { type: 'image_url', image_url: { url: IMAGE_URL } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content?: string } }>;
  };
  dispose();

  const turnStart = events.find((e) => e.type === 'turn.start');
  const turnEnd = events.find((e) => e.type === 'turn.end');
  const usage = events.find((e) => e.type === 'usage');

  if (turnStart?.type === 'turn.start') {
    console.log(`provider:    ${turnStart.provider}`);
    console.log(`model:       ${turnStart.model}`);
    const userMsg = turnStart.request.messages[0];
    if (userMsg && Array.isArray(userMsg.content)) {
      console.log(`request:     ${userMsg.content.length} content parts (text + image)`);
      for (const part of userMsg.content) {
        if (part.type === 'text') console.log(`             - text: "${part.text}"`);
        // image_url stringifies through normalizer as [image:...]
      }
    }
  }
  if (turnEnd?.type === 'turn.end') {
    const text = turnEnd.response?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    console.log(`\nmodel reply: ${text}`);
  }
  if (usage?.type === 'usage') {
    console.log(`tokens:      in=${usage.usage.inputTokens} out=${usage.usage.outputTokens}`);
  }

  const finalText = json.choices[0]?.message.content ?? '';
  console.log(`\nraw text:    ${finalText.slice(0, 200)}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
