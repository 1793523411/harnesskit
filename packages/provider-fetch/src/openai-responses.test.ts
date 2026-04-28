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
        controller.enqueue(
          encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
        );
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

describe('OpenAI Responses API L1', () => {
  it('non-streaming: emits turn.start, turn.end, usage, tool.call.requested', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'I will list it.' }],
            },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_R',
              name: 'shell',
              arguments: '{"cmd":"ls"}',
            },
          ],
          usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 },
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5',
        input: 'list dir',
      }),
    });
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('openai-responses');
    expect(turnStart.model).toBe('gpt-5');

    const toolEvt = events[3];
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('call_R');
    expect(toolEvt.call.input).toEqual({ cmd: 'ls' });
  });

  it('streaming: assembles deltas across SSE events', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () => {
        const stream = sseStream([
          {
            event: 'response.created',
            data: { type: 'response.created', response: { id: 'resp_2', model: 'gpt-5' } },
          },
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'function_call',
                id: 'fc_s',
                call_id: 'call_S',
                name: 'shell',
                arguments: '',
              },
            },
          },
          {
            event: 'response.function_call_arguments.delta',
            data: {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: '{"cmd":',
            },
          },
          {
            event: 'response.function_call_arguments.delta',
            data: {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: '"ls"}',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                status: 'completed',
                usage: { input_tokens: 5, output_tokens: 7 },
              },
            },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    const response = await target.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'list' }],
      }),
    });
    await response.text();
    await new Promise((r) => setTimeout(r, 20));
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const toolEvt = events[3];
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('call_S');
    expect(toolEvt.call.input).toEqual({ cmd: 'ls' });
  });

  it('rewrites function_call_output items by call_id when denied', async () => {
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
      | { input: Array<{ type: string; call_id?: string; output?: string }> }
      | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({
            id: 'resp_x',
            model: 'gpt-5',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_x',
                call_id: 'call_Z',
                name: 'shell',
                arguments: '{"cmd":"rm -rf"}',
              },
            ],
          });
        }
        secondReq = JSON.parse(init?.body as string);
        return mockResponse({
          id: 'resp_y',
          model: 'gpt-5',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_y',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'noted' }],
            },
          ],
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'rm everything' }],
      }),
    });

    await target.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5',
        input: [
          { type: 'message', role: 'user', content: 'rm everything' },
          {
            type: 'function_call',
            id: 'fc_x',
            call_id: 'call_Z',
            name: 'shell',
            arguments: '{"cmd":"rm -rf"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_Z',
            output: '(host pretends it ran)',
          },
        ],
      }),
    });
    dispose();

    expect(secondReq).toBeDefined();
    const fco = secondReq?.input.find((i) => i.type === 'function_call_output');
    expect(fco?.output).toContain('shell disabled');
  });
});
