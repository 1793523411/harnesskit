// Demo 4: OpenTelemetry exporter wired up with a console-printing tracer.
// Renders the captured spans as an indented tree.
//
// Run: pnpm --filter @harnesskit/examples demo:otel

import { type OtelSpan, type OtelTracer, otelExporter } from '@harnesskit/otel';
import { denyTools } from '@harnesskit/policy';
import { runAgent } from '@harnesskit/runner';
import { ALL_CUSTOM_HOSTS, PROVIDERS } from './_config.js';

const v = PROVIDERS.volcengine();

interface Span {
  name: string;
  attrs: Record<string, unknown>;
  status?: { code: number; message?: string };
  startTime: number;
  endTime?: number;
}

const consoleTracer = (): { tracer: OtelTracer; spans: Span[] } => {
  const spans: Span[] = [];
  return {
    spans,
    tracer: {
      startSpan(name, options) {
        const span: Span = {
          name,
          attrs: { ...(options?.attributes ?? {}) },
          startTime: options?.startTime ?? Date.now(),
        };
        spans.push(span);
        const otel: OtelSpan = {
          setAttribute: (k, val) => {
            span.attrs[k] = val;
          },
          setStatus: (s) => {
            span.status = s;
          },
          end: (t) => {
            span.endTime = t ?? Date.now();
          },
        };
        return otel;
      },
    },
  };
};

const renderTree = (spans: Span[]): void => {
  if (spans.length === 0) {
    console.log('  (no spans captured)');
    return;
  }
  const t0 = Math.min(...spans.map((s) => s.startTime));
  for (const s of spans) {
    const indent = s.name.startsWith('harnesskit.tool')
      ? '    └─ '
      : s.name.startsWith('harnesskit.turn')
        ? '  ├─ '
        : '';
    const duration = s.endTime !== undefined ? `${s.endTime - s.startTime}ms` : 'open';
    const status = s.status?.code === 2 ? ' [ERROR]' : '';
    const attrSummary = ['gen_ai.request.model', 'tool.name', 'tool.deny_reason']
      .map((k) => (s.attrs[k] ? `${k}=${s.attrs[k]}` : null))
      .filter(Boolean)
      .join(' ');
    console.log(
      `${indent}${s.name.padEnd(30)} +${(s.startTime - t0).toString().padStart(4)}ms · ${duration.padStart(6)}${status}  ${attrSummary}`,
    );
  }
};

const main = async (): Promise<void> => {
  console.log('=== OpenTelemetry exporter — span tree from a real agent run ===\n');

  const { tracer, spans } = consoleTracer();
  const result = await runAgent({
    baseUrl: v.baseUrl,
    apiKey: v.apiKey,
    model: v.fast,
    customHosts: ALL_CUSTOM_HOSTS,
    systemPrompt: 'You help check files. Use the read_file tool when appropriate.',
    prompt: 'Read /etc/hosts and tell me what is in it.',
    tools: {
      shell: {
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        execute: async () => '(host pretends shell ran)',
      },
      read_file: {
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        execute: async (args: Record<string, unknown>) =>
          args.path === '/etc/hosts' ? '127.0.0.1 localhost\n::1 localhost' : '(not found)',
      },
    },
    policies: [denyTools(['shell'])],
    interceptors: [otelExporter({ tracer })],
    maxRounds: 5,
  });

  console.log(`final answer: ${result.text.slice(0, 100)}${result.text.length > 100 ? '…' : ''}\n`);
  console.log('span tree:');
  renderTree(spans);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
