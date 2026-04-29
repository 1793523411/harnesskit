import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { installFetchInterceptor } from './intercept.js';

const mockResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const sseStream = (events: { event: string; data: unknown }[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        const payload = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      }
      controller.close();
    },
  });
};

const collectEvents = (bus: EventBus): AgentEvent[] => {
  const events: AgentEvent[] = [];
  bus.use({
    on: (e) => {
      events.push(e);
    },
  });
  return events;
};

describe('Anthropic L1 interceptor', () => {
  it('passes through non-Anthropic URLs unchanged', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    let called = false;
    const target = {
      fetch: async () => {
        called = true;
        return mockResponse({ ok: true });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch('https://example.com/api', { method: 'POST', body: '{}' });
    dispose();
    expect(called).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('emits turn.start, turn.end, usage, and tool.call.requested for non-streaming', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'I will read the file.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'read_file',
              input: { path: '/etc/passwd' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'read /etc/passwd' }],
      }),
    });
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('anthropic');
    expect(turnStart.model).toBe('claude-opus-4-7');
    expect(turnStart.request.messages).toHaveLength(1);

    const toolEvt = events[3];
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('toolu_1');
    expect(toolEvt.call.name).toBe('read_file');
  });

  it('parses streaming responses and emits the same event sequence', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () => {
        const stream = sseStream([
          {
            event: 'message_start',
            data: {
              type: 'message_start',
              message: {
                id: 'msg_2',
                model: 'claude-opus-4-7',
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_s1', name: 'shell', input: {} },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
            },
          },
          {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '"ls"}' },
            },
          },
          {
            event: 'content_block_stop',
            data: { type: 'content_block_stop', index: 1 },
          },
          {
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 18 },
            },
          },
          { event: 'message_stop', data: { type: 'message_stop' } },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    const response = await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'list' }],
      }),
    });

    // Drain the host-side body so the tee completes
    await response.text();
    // Allow the async stream-consumption side to finish
    await new Promise((r) => setTimeout(r, 20));
    dispose();

    const types = events.map((e) => e.type);
    // Eager emission: tool.call.requested fires AS the tool_use content block
    // completes mid-stream, before turn.end / usage.
    expect(types).toEqual(['turn.start', 'tool.call.requested', 'turn.end', 'usage']);

    const toolEvt = events.find((e) => e.type === 'tool.call.requested');
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('toolu_s1');
    expect(toolEvt.call.input).toEqual({ cmd: 'ls' });
  });

  it('aborts mid-stream when policy denies a tool_use', async () => {
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
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (event: string, data: unknown) =>
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            send('message_start', {
              type: 'message_start',
              message: {
                id: 'msg_x',
                model: 'claude-opus-4-7',
                usage: { input_tokens: 5, output_tokens: 0 },
              },
            });
            send('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_x', name: 'shell', input: {} },
            });
            send('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
            });
            send('content_block_stop', { type: 'content_block_stop', index: 0 });
            // Aborted here — these next chunks should never be processed
            await new Promise((r) => setTimeout(r, 10));
            send('content_block_start', {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: '' },
            });
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

    const response = await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        stream: true,
        messages: [{ role: 'user', content: 'do it' }],
      }),
    });
    await response.text();
    await new Promise((r) => setTimeout(r, 50));
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toContain('tool.call.requested');
    expect(types).toContain('tool.call.denied');
    expect(cancelCalled).toBe(true);
  });

  it('rewrites tool_result on the next request when a tool_use was denied', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell is not allowed', 'no-shell');
        }
      },
    });

    let callCount = 0;
    let secondRequestBody: unknown;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({
            id: 'msg_a',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-4-7',
            content: [
              { type: 'tool_use', id: 'toolu_x', name: 'shell', input: { cmd: 'rm -rf /' } },
            ],
            stop_reason: 'tool_use',
          });
        }
        secondRequestBody = JSON.parse(init?.body as string);
        return mockResponse({
          id: 'msg_b',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'noted' }],
          stop_reason: 'end_turn',
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    // First call — model wants to run shell, policy denies
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'rm everything' }],
      }),
    });

    // Second call — host SDK pretends it ran the tool and sends the result back.
    // Our interceptor must rewrite that tool_result with an error.
    await target.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        messages: [
          { role: 'user', content: 'rm everything' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_x', name: 'shell', input: { cmd: 'rm -rf /' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_x',
                content: '(host pretends it ran)',
              },
            ],
          },
        ],
      }),
    });
    dispose();

    expect(secondRequestBody).toBeDefined();
    const lastMsg = (
      secondRequestBody as { messages: { role: string; content: unknown }[] }
    ).messages.at(-1);
    const blocks = lastMsg?.content as Array<{
      type: string;
      tool_use_id: string;
      is_error?: boolean;
      content: string;
    }>;
    const block = blocks[0];
    expect(block).toBeDefined();
    expect(block?.is_error).toBe(true);
    expect(block?.content).toContain('shell is not allowed');
  });
});
