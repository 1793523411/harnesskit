import { type AgentEvent, EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import { installFetchInterceptor } from './intercept.js';

const mockResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const sseStream = (
  chunks: unknown[],
  opts: { withDone?: boolean } = {},
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      if (opts.withDone !== false) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
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

describe('OpenAI Chat Completions L1', () => {
  it('emits turn.start, turn.end, usage, tool.call.requested for non-streaming', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'shell', arguments: '{"cmd":"ls"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'list dir' }],
      }),
    });
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('openai');
    expect(turnStart.model).toBe('gpt-4o');

    const usage = events[2];
    if (usage?.type !== 'usage') throw new Error('expected usage');
    expect(usage.usage.inputTokens).toBe(12);
    expect(usage.usage.outputTokens).toBe(7);

    const toolEvt = events[3];
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('call_a');
    expect(toolEvt.call.input).toEqual({ cmd: 'ls' });
  });

  it('parses streaming responses with tool_calls split across chunks', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () => {
        const stream = sseStream([
          {
            id: 'chatcmpl_2',
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
          },
          {
            id: 'chatcmpl_2',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_s',
                      type: 'function',
                      function: { name: 'shell', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: 'chatcmpl_2',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"cm' } }],
                },
              },
            ],
          },
          {
            id: 'chatcmpl_2',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'd":"ls"}' } }],
                },
              },
            ],
          },
          {
            id: 'chatcmpl_2',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    const response = await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'list' }],
      }),
    });
    await response.text();
    await new Promise((r) => setTimeout(r, 20));
    dispose();

    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn.start', 'turn.end', 'usage', 'tool.call.requested']);

    const toolEvt = events[3];
    if (toolEvt?.type !== 'tool.call.requested') throw new Error('expected tool.call.requested');
    expect(toolEvt.call.id).toBe('call_s');
    expect(toolEvt.call.name).toBe('shell');
    expect(toolEvt.call.input).toEqual({ cmd: 'ls' });
  });

  it('actively rewrites tool-message content via rewriteToolResults', async () => {
    const bus = new EventBus();
    let observedBody: { messages: Array<{ role: string; content: unknown }> } | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedBody = JSON.parse(init?.body as string);
        return mockResponse({
          id: 'chatcmpl_y',
          object: 'chat.completion',
          model: 'gpt-4o',
          choices: [{ index: 0, message: { role: 'assistant', content: 'noted' } }],
        });
      },
    };
    const dispose = installFetchInterceptor({
      bus,
      target,
      rewriteToolResults: (content) => content.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'),
    });
    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'lookup' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_R', type: 'function', function: { name: 'lookup', arguments: '{}' } },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_R',
            content: 'Found: SSN 123-45-6789, status=ok',
          },
        ],
      }),
    });
    dispose();

    const toolMsg = observedBody?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('Found: SSN [SSN], status=ok');
  });

  it('rewrites tool messages on the next request when a tool_call was denied', async () => {
    const bus = new EventBus();
    bus.use({
      on: (e, ctx) => {
        if (e.type === 'tool.call.requested' && e.call.name === 'shell') {
          ctx.deny('shell disabled', 'no-shell');
        }
      },
    });

    let callCount = 0;
    let secondReq: { messages: { role: string; content: string }[] } | undefined;
    const target = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return mockResponse({
            id: 'chatcmpl_x',
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_z',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"cmd":"rm -rf"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
        }
        secondReq = JSON.parse(init?.body as string);
        return mockResponse({
          id: 'chatcmpl_y',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'noted' },
              finish_reason: 'stop',
            },
          ],
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'rm everything' }],
      }),
    });

    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: 'rm everything' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_z',
                type: 'function',
                function: { name: 'shell', arguments: '{"cmd":"rm -rf"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_z', content: '(host pretends it ran)' },
        ],
      }),
    });
    dispose();

    expect(secondReq).toBeDefined();
    const toolMsg = secondReq?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('shell disabled');
  });

  it('routes openrouter.ai traffic to the openrouter provider', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'or_1',
          model: 'anthropic/claude-opus-4-7',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });

    await target.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-7',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    dispose();

    const turnStart = events[0];
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('openrouter');
  });

  it('normalizes reasoning_content to a thinking block (non-streaming)', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'chatcmpl_r1',
          model: 'doubao-seed',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'The answer is 4.',
                reasoning_content: 'Adding 2 + 2 step by step gives 4.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 12 },
        }),
    };
    const dispose = installFetchInterceptor({ bus, target });
    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'doubao-seed',
        messages: [{ role: 'user', content: 'what is 2+2' }],
      }),
    });
    dispose();

    const turnEnd = events.find((e) => e.type === 'turn.end');
    if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
    const blocks = turnEnd.response?.content ?? [];
    expect(blocks[0]).toEqual({
      type: 'thinking',
      text: 'Adding 2 + 2 step by step gives 4.',
    });
    expect(blocks[1]).toEqual({ type: 'text', text: 'The answer is 4.' });
  });

  it('reassembles streaming reasoning_content deltas into a thinking block', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () => {
        const stream = sseStream([
          {
            id: 'chatcmpl_r2',
            model: 'doubao-seed',
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Let' } }],
          },
          { choices: [{ index: 0, delta: { reasoning_content: ' me think' } }] },
          { choices: [{ index: 0, delta: { reasoning_content: ' carefully.' } }] },
          { choices: [{ index: 0, delta: { content: 'OK.' } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]);
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const dispose = installFetchInterceptor({ bus, target });
    const res = await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'doubao-seed',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    dispose();

    const turnEnd = events.find((e) => e.type === 'turn.end');
    if (turnEnd?.type !== 'turn.end') throw new Error('expected turn.end');
    const blocks = turnEnd.response?.content ?? [];
    const thinking = blocks.find((b) => b.type === 'thinking');
    expect(thinking).toEqual({ type: 'thinking', text: 'Let me think carefully.' });
    const text = blocks.find((b) => b.type === 'text');
    expect(text).toEqual({ type: 'text', text: 'OK.' });
  });

  it('detects OpenAI-compatible endpoints at non-/v1/ paths via customHosts', async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const target = {
      fetch: async () =>
        mockResponse({
          id: 'volcengine_demo',
          model: 'doubao-seed',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
        }),
    };
    const dispose = installFetchInterceptor({
      bus,
      target,
      customHosts: { openai: ['ark.cn-beijing.volces.com'] },
    });
    await target.fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'doubao-seed', messages: [{ role: 'user', content: 'hi' }] }),
    });
    dispose();

    const turnStart = events.find((e) => e.type === 'turn.start');
    if (turnStart?.type !== 'turn.start') throw new Error('expected turn.start');
    expect(turnStart.provider).toBe('openai');
  });
});
