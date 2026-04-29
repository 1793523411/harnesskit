import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { encodeFrameForTest } from './providers/bedrock/eventstream.js';
import { installFetchInterceptor } from './intercept.js';

const eventStreamBody = (
  events: Array<{
    eventType: string;
    payload: Record<string, unknown>;
    messageType?: string;
  }>,
): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        const headers: Record<string, string> = {
          ':event-type': ev.eventType,
          ':content-type': 'application/json',
          ':message-type': ev.messageType ?? 'event',
        };
        const frame = encodeFrameForTest(headers, enc.encode(JSON.stringify(ev.payload)));
        controller.enqueue(frame);
      }
      controller.close();
    },
  });
};

const mockResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const collectEvents = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  return events;
};

const URL_CONVERSE =
  'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse';

describe('Bedrock Converse L1', () => {
  it('detects /converse, extracts model from URL, and emits the standard event sequence', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          output: {
            message: {
              role: 'assistant',
              content: [
                { text: 'Looking it up.' },
                {
                  toolUse: {
                    toolUseId: 'tu_1',
                    name: 'lookup',
                    input: { city: 'Tokyo' },
                  },
                },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 11, outputTokens: 14, totalTokens: 25 },
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch(URL_CONVERSE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'AWS4-HMAC-SHA256 ...',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: 'weather in Tokyo' }] }],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'lookup',
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                  },
                },
              },
            },
          ],
        },
        inferenceConfig: { maxTokens: 256 },
      }),
    });
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('bedrock');
    // URL-encoded ":" decodes to ":"
    expect(turnStart.model).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(turnStart.request.tools).toHaveLength(1);
    expect(turnStart.request.tools?.[0]?.name).toBe('lookup');

    const usage = events.find((e) => e.type === 'usage');
    if (usage?.type !== 'usage') throw new Error('expected usage');
    expect(usage.usage.inputTokens).toBe(11);
    expect(usage.usage.outputTokens).toBe(14);

    const tool = events.find((e) => e.type === 'tool.call.requested');
    if (tool?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(tool.call.id).toBe('tu_1');
    expect(tool.call.name).toBe('lookup');
    expect(tool.call.input).toEqual({ city: 'Tokyo' });
  });

  it('rewrites toolResult content on the next request when a toolUse was denied', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });

    let callCount = 0;
    let secondReq:
      | {
          messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
        }
      | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({
            output: {
              message: {
                role: 'assistant',
                content: [
                  {
                    toolUse: {
                      toolUseId: 'tu_x',
                      name: 'shell',
                      input: { cmd: 'rm -rf' },
                    },
                  },
                ],
              },
            },
            stopReason: 'tool_use',
          });
        }
        secondReq = JSON.parse(init?.body as string);
        return mockResponse({
          output: { message: { role: 'assistant', content: [{ text: 'noted' }] } },
          stopReason: 'end_turn',
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    // round 1: model wants to run shell, policy denies
    await target.fetch(URL_CONVERSE, {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: [{ text: 'rm everything' }] }],
      }),
    });

    // round 2: host pretends it ran the tool and posts a toolResult
    await target.fetch(URL_CONVERSE, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [{ text: 'rm everything' }] },
          {
            role: 'assistant',
            content: [
              { toolUse: { toolUseId: 'tu_x', name: 'shell', input: { cmd: 'rm -rf' } } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'tu_x',
                  content: [{ text: '(host pretends it ran)' }],
                },
              },
            ],
          },
        ],
      }),
    });
    dispose();

    expect(secondReq).toBeDefined();
    const lastUser = secondReq?.messages.at(-1);
    const tr = lastUser?.content[0] as {
      toolResult?: { content: Array<{ text?: string }>; status?: string };
    };
    expect(tr?.toolResult?.status).toBe('error');
    const text = tr?.toolResult?.content[0]?.text ?? '';
    expect(text).toContain('shell disabled');
  });

  it('rewrites toolResult content via rewriteToolResults', async () => {
    const bus = new EventBus();
    let observedReq:
      | { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
      | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedReq = JSON.parse(init?.body as string);
        return mockResponse({
          output: { message: { role: 'assistant', content: [{ text: 'noted' }] } },
          stopReason: 'end_turn',
        });
      },
    };
    const dispose = installFetchInterceptor({
      bus,
      target,
      rewriteToolResults: (content) =>
        content.replace(/\b\w+@\w+\.\w+\b/g, '[email]'),
    });

    await target.fetch(URL_CONVERSE, {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'tu_lookup',
                  content: [{ text: 'Found: alice@example.com' }],
                },
              },
            ],
          },
        ],
      }),
    });
    dispose();

    const last = observedReq?.messages.at(-1);
    const tr = last?.content[0] as { toolResult?: { content: Array<{ text?: string }> } };
    expect(tr?.toolResult?.content[0]?.text).toBe('Found: [email]');
  });

  it('does NOT detect /invoke (per-model invoke API is not Converse)', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    let underlyingCalled = false;
    const target = {
      fetch: async () => {
        underlyingCalled = true;
        return mockResponse({});
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/invoke',
      {
        method: 'POST',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    dispose();
    expect(underlyingCalled).toBe(true);
    expect(events.find((e) => e.type === 'turn.start')).toBeUndefined();
  });

  it('parses /converse-stream Event Stream frames into a normalized response', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        new Response(
          eventStreamBody([
            { eventType: 'messageStart', payload: { role: 'assistant' } },
            // Text block 0
            {
              eventType: 'contentBlockDelta',
              payload: { contentBlockIndex: 0, delta: { text: 'Hello ' } },
            },
            {
              eventType: 'contentBlockDelta',
              payload: { contentBlockIndex: 0, delta: { text: 'world' } },
            },
            { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
            // Tool use block 1
            {
              eventType: 'contentBlockStart',
              payload: {
                contentBlockIndex: 1,
                start: { toolUse: { toolUseId: 'tu_s', name: 'shell' } },
              },
            },
            {
              eventType: 'contentBlockDelta',
              payload: {
                contentBlockIndex: 1,
                delta: { toolUse: { input: '{"cmd":' } },
              },
            },
            {
              eventType: 'contentBlockDelta',
              payload: {
                contentBlockIndex: 1,
                delta: { toolUse: { input: '"ls"}' } },
              },
            },
            { eventType: 'contentBlockStop', payload: { contentBlockIndex: 1 } },
            { eventType: 'messageStop', payload: { stopReason: 'tool_use' } },
            {
              eventType: 'metadata',
              payload: {
                usage: { inputTokens: 9, outputTokens: 11, totalTokens: 20 },
                metrics: { latencyMs: 412 },
              },
            },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/vnd.amazon.eventstream' },
          },
        ),
    };
    const dispose = installFetchInterceptor({ bus, target });
    const res = await target.fetch(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse-stream',
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ text: 'list files' }] }],
        }),
      },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    dispose();

    const turnEnd = events.find((e) => e.type === 'turn.end');
    if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
    const text = turnEnd.response?.content
      ?.filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    expect(text).toBe('Hello world');

    const usage = events.find((e) => e.type === 'usage');
    if (usage?.type !== 'usage') throw new Error('expected usage');
    expect(usage.usage.inputTokens).toBe(9);
    expect(usage.usage.outputTokens).toBe(11);

    // Eager: tool.call.requested fires from contentBlockStop, before turn.end
    const tool = events.find((e) => e.type === 'tool.call.requested');
    if (tool?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(tool.call.id).toBe('tu_s');
    expect(tool.call.name).toBe('shell');
    expect(tool.call.input).toEqual({ cmd: 'ls' });
    const types = events.map((e) => e.type);
    expect(types.indexOf('tool.call.requested')).toBeLessThan(types.indexOf('turn.end'));
  });

  it('aborts /converse-stream mid-stream when policy denies a toolUse', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });
    const events = collectEvents(bus);
    let cancelCalled = false;
    const target = {
      fetch: async () => {
        const stream = eventStreamBody([
          { eventType: 'messageStart', payload: { role: 'assistant' } },
          {
            eventType: 'contentBlockStart',
            payload: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'tu_x', name: 'shell' } },
            },
          },
          {
            eventType: 'contentBlockDelta',
            payload: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"cmd":"rm -rf"}' } },
            },
          },
          { eventType: 'contentBlockStop', payload: { contentBlockIndex: 0 } },
          // These should never be processed if abort works — a second toolUse
          // we'd otherwise emit, plus stop frames.
          {
            eventType: 'contentBlockStart',
            payload: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'tu_late', name: 'should_not_emit' } },
            },
          },
          {
            eventType: 'contentBlockDelta',
            payload: { contentBlockIndex: 1, delta: { toolUse: { input: '{}' } } },
          },
          { eventType: 'contentBlockStop', payload: { contentBlockIndex: 1 } },
          { eventType: 'messageStop', payload: { stopReason: 'tool_use' } },
        ]);
        // Wrap the stream so we can observe cancel()
        const wrapped = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = stream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } finally {
              controller.close();
            }
          },
          cancel() {
            cancelCalled = true;
          },
        });
        return new Response(wrapped, {
          status: 200,
          headers: { 'content-type': 'application/vnd.amazon.eventstream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    const res = await target.fetch(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse-stream',
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ text: 'do it' }] }],
        }),
      },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.call.denied');
    expect(cancelCalled).toBe(true);
    const calls = events.filter((e) => e.type === 'tool.call.requested');
    expect(calls).toHaveLength(1);
  });

  it('surfaces a server exception frame as an error event', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        new Response(
          eventStreamBody([
            {
              eventType: 'throttlingException',
              messageType: 'exception',
              payload: { message: 'Rate exceeded for model' },
            },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/vnd.amazon.eventstream' },
          },
        ),
    };
    const dispose = installFetchInterceptor({ bus, target });
    const res = await target.fetch(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse-stream',
      {
        method: 'POST',
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ text: 'hi' }] }],
        }),
      },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    dispose();

    const err = events.find((e) => e.type === 'error');
    if (err?.type !== 'error') throw new Error('expected error event');
    expect(err.message).toContain('Rate exceeded');
  });
});
