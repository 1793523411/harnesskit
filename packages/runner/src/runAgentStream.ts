import {
  type AgentEvent,
  EventBus,
  type Interceptor,
  type Policy,
} from '@harnesskit/core';
import { type Trace, TraceRecorder } from '@harnesskit/eval';
import { policyToInterceptor } from '@harnesskit/policy';
import {
  type FetchInterceptorOptions,
  installFetchInterceptor,
  parseSseStream,
} from '@harnesskit/provider-fetch';
import type { RunAgentResult, ToolDefinition } from './runAgent.js';

export interface RunAgentStreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  tools?: Record<string, ToolDefinition>;
  systemPrompt?: string;
  prompt: string;
  bus?: EventBus;
  policies?: readonly Policy[];
  interceptors?: readonly Interceptor[];
  recorder?: boolean | TraceRecorder;
  customHosts?: FetchInterceptorOptions['customHosts'];
  maxRounds?: number;
}

/** A chunk emitted by `runAgentStream`. */
export type RunAgentStreamChunk =
  | { type: 'text.delta'; round: number; delta: string }
  | { type: 'reasoning.delta'; round: number; delta: string }
  | { type: 'tool.call.started'; round: number; id: string; name: string; input: unknown }
  | {
      type: 'tool.call.finished';
      round: number;
      id: string;
      name: string;
      result: unknown;
      error?: string;
    }
  | { type: 'round.end'; round: number; finishReason?: string }
  | { type: 'done'; result: RunAgentResult };

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

interface ToolAccum {
  id?: string;
  name?: string;
  argParts: string[];
}

const safeParse = (s: string): Record<string, unknown> => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Streaming sibling of {@link runAgent}. Returns an `AsyncGenerator` that
 * yields `text.delta`, `tool.call.*`, `round.end`, and finally a single
 * `done` chunk carrying the same `RunAgentResult` that {@link runAgent}
 * returns when buffered.
 *
 * Usage:
 *
 * ```ts
 * for await (const chunk of runAgentStream({ ... })) {
 *   if (chunk.type === 'text.delta') process.stdout.write(chunk.delta);
 *   else if (chunk.type === 'done') console.log('total tokens:', chunk.result.events);
 * }
 * ```
 */
export async function* runAgentStream(
  opts: RunAgentStreamOptions,
): AsyncGenerator<RunAgentStreamChunk, void, void> {
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
          stream: true,
          ...(toolDecls.length > 0 ? { tools: toolDecls } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`runAgentStream: HTTP ${res.status}: ${await res.text()}`);
      }
      if (!res.body) {
        throw new Error('runAgentStream: response has no body');
      }

      const round = rounds;
      const textParts: string[] = [];
      const toolMap = new Map<number, ToolAccum>();
      let finishReason: string | undefined;

      const reader = parseSseStream(res.body).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.data === '[DONE]') break;
          const data = safeParse(value.data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
          };
          const choice = data.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
          const delta = choice.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            textParts.push(delta.content);
            yield { type: 'text.delta', round, delta: delta.content };
          }
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield { type: 'reasoning.delta', round, delta: delta.reasoning_content };
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const td of delta.tool_calls) {
              const idx = td.index ?? 0;
              let acc = toolMap.get(idx);
              if (!acc) {
                acc = { argParts: [] };
                toolMap.set(idx, acc);
              }
              if (typeof td.id === 'string') acc.id = td.id;
              if (td.function) {
                if (typeof td.function.name === 'string') acc.name = td.function.name;
                if (typeof td.function.arguments === 'string') {
                  acc.argParts.push(td.function.arguments);
                }
              }
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }

      yield { type: 'round.end', round, ...(finishReason ? { finishReason } : {}) };

      const assembledTextContent = textParts.length > 0 ? textParts.join('') : null;
      const assembledToolCalls = [...toolMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => {
          if (!tc.id || !tc.name) return undefined;
          return {
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.argParts.join('') },
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== undefined);

      const assistant: ChatMessage = { role: 'assistant', content: assembledTextContent };
      if (assembledToolCalls.length > 0) assistant.tool_calls = assembledToolCalls;
      messages.push(assistant);

      if (assembledToolCalls.length === 0) {
        text = assembledTextContent ?? '';
        break;
      }

      for (const tc of assembledToolCalls) {
        const args = safeParse(tc.function.arguments ?? '{}');
        yield { type: 'tool.call.started', round, id: tc.id, name: tc.function.name, input: args };
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
        yield {
          type: 'tool.call.finished',
          round,
          id: tc.id,
          name: tc.function.name,
          result,
          ...(error !== undefined ? { error } : {}),
        };
      }
    }
  } finally {
    dispose();
  }

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
  yield { type: 'done', result };
}
