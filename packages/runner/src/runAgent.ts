import { type AgentEvent, EventBus, type Interceptor, type Policy } from '@harnesskit/core';
import { type Trace, TraceRecorder } from '@harnesskit/eval';
import { policyToInterceptor } from '@harnesskit/policy';
import { type FetchInterceptorOptions, installFetchInterceptor } from '@harnesskit/provider-fetch';

export interface ToolDefinition {
  description?: string;
  parameters?: unknown;
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface RunAgentOptions {
  /** OpenAI-compatible base URL — e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Bearer token. */
  apiKey: string;
  /** Model id to send. */
  model: string;
  /** Tool registry. The agent loop calls `execute` with parsed args. */
  tools?: Record<string, ToolDefinition>;
  /** System prompt prepended to messages. */
  systemPrompt?: string;
  /** User prompt. */
  prompt: string;

  /** Optional pre-built bus. If omitted, a fresh one is created. */
  bus?: EventBus;
  /** Policies to add (only when no bus is provided, to avoid duplicate registration). */
  policies?: readonly Policy[];
  /** Extra raw interceptors (only when no bus is provided). */
  interceptors?: readonly Interceptor[];
  /** Attach a TraceRecorder. Default: true. */
  recorder?: boolean | TraceRecorder;
  /** Forwarded to installFetchInterceptor; useful for custom hosts. */
  customHosts?: FetchInterceptorOptions['customHosts'];

  /** Maximum loop iterations. Default: 10. */
  maxRounds?: number;
  /** Optional callback invoked on every model reply (assistant message). */
  onAssistantMessage?: (msg: { content: string | null; tool_calls?: unknown[] }) => void;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface RunAgentResult {
  /** Final assistant text. Empty if loop hit maxRounds without a text-only reply. */
  text: string;
  /** Every tool call the model made, with the result returned by your executor. */
  toolCalls: Array<{
    id: string;
    name: string;
    input: unknown;
    result: unknown;
    error?: string;
  }>;
  /** Every event the bus saw. */
  events: AgentEvent[];
  /** The final trace, if a TraceRecorder was attached. */
  trace?: Trace;
  /** Number of model API calls. */
  rounds: number;
  /** Conversation transcript at exit, including all tool messages. */
  messages: ChatMessage[];
}

const safeParse = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export const runAgent = async (opts: RunAgentOptions): Promise<RunAgentResult> => {
  const bus = opts.bus ?? new EventBus();
  const ownsBus = opts.bus === undefined;
  const events: AgentEvent[] = [];
  bus.use({
    name: 'runner-collector',
    on: (e) => {
      events.push(e);
    },
  });

  if (ownsBus) {
    for (const p of opts.policies ?? []) bus.use(policyToInterceptor(p));
    for (const i of opts.interceptors ?? []) bus.use(i);
  }

  let recorder: TraceRecorder | undefined;
  if (opts.recorder === false) {
    recorder = undefined;
  } else if (opts.recorder instanceof TraceRecorder) {
    recorder = opts.recorder;
  } else {
    recorder = new TraceRecorder();
    bus.use(recorder);
  }

  const installOpts: FetchInterceptorOptions = { bus };
  if (opts.customHosts) installOpts.customHosts = opts.customHosts;
  const dispose = installFetchInterceptor(installOpts);

  const tools = opts.tools ?? {};
  const messages: ChatMessage[] = [];
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
  messages.push({ role: 'user', content: opts.prompt });

  const toolDecls = Object.entries(tools).map(([name, t]) => ({
    type: 'function' as const,
    function: {
      name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
    },
  }));

  const toolCalls: RunAgentResult['toolCalls'] = [];
  let text = '';
  let rounds = 0;
  const maxRounds = opts.maxRounds ?? 10;

  try {
    for (let i = 0; i < maxRounds; i++) {
      rounds++;
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          ...(toolDecls.length > 0 ? { tools: toolDecls } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`runAgent: HTTP ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
      const msg = json.choices[0]?.message;
      if (!msg) break;
      messages.push(msg);
      opts.onAssistantMessage?.({
        content: msg.content ?? null,
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        text = msg.content ?? '';
        break;
      }

      for (const tc of msg.tool_calls) {
        const args = safeParse(tc.function.arguments ?? '{}');
        const tool = tools[tc.function.name];
        let result: unknown = `(no executor for tool "${tc.function.name}")`;
        let error: string | undefined;
        if (tool) {
          try {
            result = await tool.execute(args);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            result = `ERROR: ${error}`;
          }
        }
        const entry: RunAgentResult['toolCalls'][number] = {
          id: tc.id,
          name: tc.function.name,
          input: args,
          result,
        };
        if (error !== undefined) entry.error = error;
        toolCalls.push(entry);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }
  } finally {
    dispose();
  }

  // Pick trace for the captured session if recorder is set.
  let trace: Trace | undefined;
  if (recorder) {
    const all = recorder.allTraces();
    trace = all[all.length - 1];
  }

  const result: RunAgentResult = {
    text,
    toolCalls,
    events,
    rounds,
    messages,
  };
  if (trace) result.trace = trace;
  return result;
};
