// Shared helper: a fake fetch target that returns canned Anthropic responses.
// Lets the examples run end-to-end without a real API key.

const cannedTurn1 = {
  id: 'msg_demo_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [
    { type: 'text', text: "I'll list the directory." },
    {
      type: 'tool_use',
      id: 'toolu_demo_a',
      name: 'shell',
      input: { cmd: 'ls /etc' },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 18, output_tokens: 9 },
};

const cannedTurn2 = {
  id: 'msg_demo_2',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [
    {
      type: 'text',
      text: "Got it — looks like that command was blocked. I'll switch to read_file instead.",
    },
    {
      type: 'tool_use',
      id: 'toolu_demo_b',
      name: 'read_file',
      input: { path: '/etc/hostname' },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 22, output_tokens: 14 },
};

const cannedTurn3 = {
  id: 'msg_demo_3',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [{ type: 'text', text: 'Done — your hostname is in the file.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 24, output_tokens: 8 },
};

const responses = [cannedTurn1, cannedTurn2, cannedTurn3];

export const makeMockTarget = (): { fetch: typeof fetch } => {
  let i = 0;
  return {
    fetch: async (_input, _init) => {
      const body = responses[i % responses.length];
      i++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
};

export const callAnthropic = async (
  target: { fetch: typeof fetch },
  messages: { role: 'user' | 'assistant'; content: unknown }[],
): Promise<unknown> => {
  const res = await target.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-fake-for-demo' },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      messages,
    }),
  });
  return res.json();
};
