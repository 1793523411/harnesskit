import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { installFetchInterceptor } from './intercept.js';

const mockResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const sseStream = (chunks: unknown[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.close();
    },
  });
};

const collectEvents = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({ on: (e) => void events.push(e) });
  return events;
};

describe('Gemini L1 interceptor', () => {
  it('extracts model from URL path and emits standard event sequence', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Hello!' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          modelVersion: 'gemini-1.5-pro',
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=KEY',
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      },
    );
    dispose();

    const turnStart = events.find((e) => e.type === 'turn.start');
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('google');
    expect(turnStart.model).toBe('gemini-1.5-pro');

    const usage = events.find((e) => e.type === 'usage');
    if (usage?.type !== 'usage') throw new Error('expected usage');
    expect(usage.usage.inputTokens).toBe(5);
    expect(usage.usage.outputTokens).toBe(2);
  });

  it('emits tool.call.requested for functionCall parts', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Calling weather…' },
                  { functionCall: { id: 'fc_a', name: 'get_weather', args: { city: 'Tokyo' } } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'weather in Tokyo' }] }],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        }),
      },
    );
    dispose();

    const tool = events.find((e) => e.type === 'tool.call.requested');
    if (tool?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(tool.call.id).toBe('fc_a');
    expect(tool.call.name).toBe('get_weather');
    expect(tool.call.input).toEqual({ city: 'Tokyo' });
  });

  it('normalizes thought parts to thinking blocks (Gemini 2.5)', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Let me reason about this.', thought: true },
                  { text: 'The answer is 4.' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '2+2?' }] }] }),
      },
    );
    dispose();

    const turnEnd = events.find((e) => e.type === 'turn.end');
    if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
    const blocks = turnEnd.response?.content ?? [];
    expect(blocks[0]).toEqual({ type: 'thinking', text: 'Let me reason about this.' });
    expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 4.' });
  });

  it('reassembles streaming SSE chunks (text + functionCall)', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () => {
        const stream = sseStream([
          {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Hello' }],
                },
              },
            ],
            modelVersion: 'gemini-1.5-flash',
          },
          {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: ' world' }] },
              },
            ],
          },
          {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'fc_s',
                        name: 'shell',
                        args: { cmd: 'ls' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 6 },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    const res = await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    dispose();

    const turnEnd = events.find((e) => e.type === 'turn.end');
    if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
    const blocks = turnEnd.response?.content ?? [];
    expect(blocks.find((b) => b.type === 'text')).toEqual({ type: 'text', text: 'Hello world' });

    const tool = events.find((e) => e.type === 'tool.call.requested');
    if (tool?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(tool.call.id).toBe('fc_s');
    expect(tool.call.input).toEqual({ cmd: 'ls' });
  });

  it('aborts mid-stream when policy denies a functionCall', async () => {
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
    let lateChunkProcessed = false;
    const target = {
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (chunk: unknown) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            send({
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      { functionCall: { id: 'fc_x', name: 'shell', args: { cmd: 'rm -rf' } } },
                    ],
                  },
                },
              ],
              modelVersion: 'gemini-1.5-pro',
            });
            // Give the consumer a tick to process + abort. If the abort isn't
            // wired up, this late chunk will be processed and we'll see it in
            // the assembled response.
            await new Promise((r) => setTimeout(r, 10));
            send({
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'should-not-arrive' }] },
                  finishReason: 'STOP',
                },
              ],
            });
            lateChunkProcessed = true;
            controller.close();
          },
          cancel() {
            cancelCalled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    const response = await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'do it' }] }] }),
      },
    );
    await response.text();
    await new Promise((r) => setTimeout(r, 50));
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.call.requested');
    expect(types).toContain('tool.call.denied');
    expect(cancelCalled).toBe(true);
    void lateChunkProcessed; // we don't strictly assert this — the source's start() may complete after cancel
    // Most importantly, only one tool.call.requested even if a late chunk
    // tries to add another functionCall.
    const calls = events.filter((e) => e.type === 'tool.call.requested');
    expect(calls).toHaveLength(1);
  });

  it('actively redacts strings inside functionResponse via rewriteToolResults', async () => {
    const bus = new EventBus();
    let observedReq:
      | { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
      | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedReq = JSON.parse(init?.body as string);
        return mockResponse({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'noted' }] }, finishReason: 'STOP' },
          ],
        });
      },
    };
    const dispose = installFetchInterceptor({
      bus,
      target,
      rewriteToolResults: (content) =>
        content.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]'),
    });
    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: 'lookup alice' }] },
            {
              role: 'model',
              parts: [{ functionCall: { id: 'fc_x', name: 'lookup', args: { q: 'alice' } } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'fc_x',
                    name: 'lookup',
                    response: { name: 'Alice', email: 'alice@example.com', meta: { tier: 'vip' } },
                  },
                },
              ],
            },
          ],
        }),
      },
    );
    dispose();

    expect(observedReq).toBeDefined();
    const last = observedReq?.contents.at(-1);
    const fr = (last?.parts?.[0] as { functionResponse?: { response?: Record<string, unknown> } })
      ?.functionResponse;
    expect(fr?.response).toMatchObject({
      name: 'Alice',
      email: '[email]',
      meta: { tier: 'vip' },
    });
  });

  it('rewrites functionResponse on next request when functionCall was denied', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });
    const events = collectEvents(bus);

    let callCount = 0;
    let secondReq:
      | { contents: Array<{ role?: string; parts?: Array<Record<string, unknown>> }> }
      | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: { id: 'fc_x', name: 'shell', args: { cmd: 'rm -rf' } },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          });
        }
        secondReq = JSON.parse(init?.body as string);
        return mockResponse({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'noted' }] },
              finishReason: 'STOP',
            },
          ],
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'do it' }] }],
        }),
      },
    );
    await target.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
      {
        method: 'POST',
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: 'do it' }] },
            {
              role: 'model',
              parts: [{ functionCall: { id: 'fc_x', name: 'shell', args: { cmd: 'rm -rf' } } }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'fc_x',
                    name: 'shell',
                    response: { output: '(host pretends ran)' },
                  },
                },
              ],
            },
          ],
        }),
      },
    );
    dispose();

    expect(secondReq).toBeDefined();
    const lastUserMsg = secondReq?.contents.at(-1);
    const fr = (lastUserMsg?.parts?.[0] as { functionResponse?: { response?: { error?: string } } })
      ?.functionResponse;
    expect(fr?.response).toMatchObject({ error: expect.stringContaining('shell disabled') });
    expect(events.filter((e) => e.type === 'tool.call.denied')).toHaveLength(1);
  });
});
