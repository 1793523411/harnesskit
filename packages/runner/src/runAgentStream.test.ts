import { afterEach, describe, expect, it } from 'vitest';
import { runAgentStream, type RunAgentStreamChunk } from './index.js';

const origFetch = globalThis.fetch;

const sseBody = (chunks: unknown[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
};

const sseResponse = (chunks: unknown[]): Response =>
  new Response(sseBody(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const mockStreaming = (rounds: ReadonlyArray<unknown[]>): typeof fetch => {
  let i = 0;
  return (async () => sseResponse(rounds[i++] ?? [])) as typeof fetch;
};

describe('runAgentStream', () => {
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('yields text deltas and finishes with a done chunk carrying the final result', async () => {
    globalThis.fetch = mockStreaming([
      [
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ]);

    const chunks: RunAgentStreamChunk[] = [];
    for await (const c of runAgentStream({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'hi',
    })) {
      chunks.push(c);
    }

    const deltas = chunks.filter((c) => c.type === 'text.delta');
    expect(deltas.map((d) => (d as { delta: string }).delta).join('')).toBe('Hello world');
    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('expected done last');
    expect(done.result.text).toBe('Hello world');
    expect(done.result.rounds).toBe(1);
  });

  it('runs a streamed tool call and feeds the result back', async () => {
    globalThis.fetch = mockStreaming([
      // round 1: tool_call assembled across deltas
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'tc1', function: { name: 'echo', arguments: '' } }],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '{"msg":' } }] } },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
      // round 2: final text reply
      [
        { choices: [{ delta: { content: 'echo said: hi' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    ]);

    const chunks: RunAgentStreamChunk[] = [];
    for await (const c of runAgentStream({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'echo hi',
      tools: {
        echo: {
          execute: (args) => `you said: ${(args as { msg: string }).msg}`,
        },
      },
    })) {
      chunks.push(c);
    }

    const started = chunks.find((c) => c.type === 'tool.call.started');
    if (started?.type !== 'tool.call.started') throw new Error('expected tool.call.started');
    expect(started.input).toEqual({ msg: 'hi' });

    const finished = chunks.find((c) => c.type === 'tool.call.finished');
    if (finished?.type !== 'tool.call.finished') throw new Error('expected tool.call.finished');
    expect(finished.result).toBe('you said: hi');

    const done = chunks.at(-1);
    if (done?.type !== 'done') throw new Error('expected done last');
    expect(done.result.text).toBe('echo said: hi');
    expect(done.result.rounds).toBe(2);
    expect(done.result.toolCalls).toHaveLength(1);
  });
});
