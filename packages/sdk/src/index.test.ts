import { denyTools } from '@harnesskit/policy';
import { describe, expect, it, vi } from 'vitest';
import { HarnessToolDeniedError, createHarness } from './index.js';

describe('createHarness', () => {
  it('collects events and records a session trace by default', async () => {
    const harness = createHarness();

    await harness.startSession({ tenant: 'demo' });
    await harness.endSession();

    expect(harness.events.map((event) => event.type)).toEqual(['session.start', 'session.end']);
    expect(harness.getTrace()?.events.map((event) => event.type)).toEqual([
      'session.start',
      'session.end',
    ]);
    await harness.dispose();
  });

  it('wraps tools with pre-flight policy denial', async () => {
    const harness = createHarness({ policies: [denyTools(['shell'])] });
    const execute = vi.fn(async () => 'ran');
    const tools = harness.wrapTools({
      shell: { execute },
    });

    await expect(tools.shell.execute({ cmd: 'rm -rf /' })).rejects.toBeInstanceOf(
      HarnessToolDeniedError,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event.type === 'tool.call.denied')).toHaveLength(1);
    await harness.dispose();
  });

  it('emits requested and resolved events for allowed wrapped tools', async () => {
    const harness = createHarness();
    const readFile = harness.wrapTool('read_file', {
      execute: async (args: { path: string }) => `contents:${args.path}`,
    });

    const result = await readFile.execute({ path: '/tmp/a.txt' }, { turnId: 'turn_test' });

    expect(result).toBe('contents:/tmp/a.txt');
    expect(harness.events.map((event) => event.type)).toEqual([
      'tool.call.requested',
      'tool.call.resolved',
    ]);
    expect(harness.events[0]?.ids.turnId).toBe('turn_test');
    await harness.dispose();
  });

  it('installs and disposes fetch interception through the facade', async () => {
    const originalFetch = vi.fn(async () => new Response('{}'));
    const target = { fetch: originalFetch as unknown as typeof fetch };
    const harness = createHarness();

    const disposeFetch = harness.installFetch({ target });
    const wrappedFetch = target.fetch;

    expect(target.fetch).not.toBe(originalFetch);
    disposeFetch();
    expect(target.fetch).not.toBe(wrappedFetch);
    await target.fetch('https://example.com');
    expect(originalFetch).toHaveBeenCalledOnce();
    await harness.dispose();
  });

  it('routes facade-installed fetch events into the harness session by default', async () => {
    const target = {
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ) as unknown as typeof fetch,
    };
    const harness = createHarness({ fetch: { target } });

    await target.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const turnStart = harness.events.find((event) => event.type === 'turn.start');
    expect(turnStart?.ids.sessionId).toBe(harness.sessionId);
    expect(harness.getTrace()?.events.some((event) => event.type === 'turn.start')).toBe(true);
    await harness.dispose();
  });
});
