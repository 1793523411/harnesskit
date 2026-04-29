import { denyTools } from '@harnesskit/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from './index.js';

const origFetch = globalThis.fetch;

const mockFetch = (
  responses: Array<{ message: { content?: string | null; tool_calls?: unknown[] } }>,
): ((...args: unknown[]) => Promise<Response>) => {
  let i = 0;
  return async () =>
    new Response(
      JSON.stringify({
        id: `chatcmpl_${i}`,
        model: 'mock-model',
        choices: [{ index: 0, message: responses[i++]?.message ?? { content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
};

describe('runAgent', () => {
  beforeEach(() => {});
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('completes a single-round chat with no tools', async () => {
    globalThis.fetch = mockFetch([{ message: { role: 'assistant', content: 'Hello!' } }]) as never;
    const result = await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'hi',
    });
    expect(result.text).toBe('Hello!');
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('runs a tool and feeds the result back', async () => {
    globalThis.fetch = mockFetch([
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"hi"}' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'echoed: hi' } },
    ]) as never;

    const result = await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'echo hi',
      tools: {
        echo: {
          execute: (args) => `echoed: ${(args.text as string) ?? '?'}`,
        },
      },
    });

    expect(result.text).toBe('echoed: hi');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: 'echo',
      input: { text: 'hi' },
      result: 'echoed: hi',
    });
    expect(result.rounds).toBe(2);
  });

  it('honors a deny policy by emitting tool.call.denied (host runs may still execute locally)', async () => {
    globalThis.fetch = mockFetch([
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc_shell',
              type: 'function',
              function: { name: 'shell', arguments: '{"cmd":"rm -rf"}' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'sorry, that did not work' } },
    ]) as never;

    let executed = false;
    const result = await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'do it',
      policies: [denyTools(['shell'])],
      tools: {
        shell: {
          execute: () => {
            executed = true;
            return 'ran';
          },
        },
      },
      maxRounds: 2,
    });

    // Note: deny is post-flight; the host (this runner) still executes the
    // tool in this round. The next round's outgoing request would have its
    // tool message rewritten to a denial — but we cap at maxRounds=2 so we
    // primarily check that tool.call.denied was emitted.
    expect(executed).toBe(true);
    const denials = result.events.filter((e) => e.type === 'tool.call.denied');
    expect(denials).toHaveLength(1);
  });

  it('captures a trace when recorder is enabled (default)', async () => {
    globalThis.fetch = mockFetch([{ message: { role: 'assistant', content: 'done' } }]) as never;
    const result = await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'q',
    });
    expect(result.trace).toBeDefined();
    expect(result.trace!.events.length).toBeGreaterThan(0);
  });

  it('respects maxRounds when the model never returns a final text', async () => {
    const repeatedToolCall = {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `tc_${Math.random()}`,
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          },
        ],
      },
    };
    globalThis.fetch = mockFetch([repeatedToolCall, repeatedToolCall, repeatedToolCall]) as never;
    const result = await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'loop',
      tools: { noop: { execute: () => 'ok' } },
      maxRounds: 3,
    });
    expect(result.rounds).toBe(3);
    expect(result.text).toBe('');
  });

  it('uses custom fetch via globalThis (interceptor catches it)', async () => {
    let captured = false;
    globalThis.fetch = vi.fn(async () => {
      captured = true;
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as never;
    await runAgent({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-mock',
      model: 'gpt-4o',
      prompt: 'go',
    });
    expect(captured).toBe(true);
  });
});
