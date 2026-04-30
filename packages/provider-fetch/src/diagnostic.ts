import type { AgentEvent, EventBus } from '@harnesskit/core';
import { HARNESSKIT_PATCHED } from './intercept.js';

export interface DiagnosticReport {
  /** Is the (possibly globalThis) fetch patched by installFetchInterceptor? */
  fetchPatched: boolean;
  /** Total events the diagnostic has observed since `start()`. */
  totalEvents: number;
  /** Per-type counts. */
  eventsByType: Record<string, number>;
  /** turn.start events seen — non-zero means the L1 wire interceptor fired. */
  turnsObserved: number;
  /** tool.call.requested events seen. */
  toolCallsObserved: number;
  /** tool.call.denied events seen — non-zero means a policy fired. */
  denials: number;
  /** error events seen, with the (truncated) message of each. */
  errors: Array<{ stage: string; message: string }>;
  /** Human-readable warnings about the current setup. */
  warnings: string[];
  /** Human-readable next-step recommendations. */
  recommendations: string[];
}

export interface CreateDiagnosticOptions {
  bus: EventBus;
  /** Defaults to globalThis. Pass a host-injected target to test it directly. */
  target?: { fetch: typeof fetch };
}

const isPatched = (target: { fetch: typeof fetch } | undefined): boolean => {
  const t = target ?? (globalThis as unknown as { fetch: typeof fetch });
  const fn = t?.fetch;
  if (!fn) return false;
  return Boolean((fn as unknown as Record<symbol, boolean>)[HARNESSKIT_PATCHED]);
};

const truncate = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Attaches a counting interceptor to the bus and exposes `report()` for
 * "did my harness see anything". Useful in two scenarios:
 *
 *  1. Onboarding — you ran your code, no events appeared, you don't know
 *     whether your fetch isn't being intercepted, your bus is wired wrong,
 *     or the URL doesn't match any provider. `report()` separates these.
 *  2. Tests — `expect(diag.report().turnsObserved).toBeGreaterThan(0)` is a
 *     compact assertion that the harness path was actually exercised.
 *
 * Usage:
 *
 * ```ts
 * const diag = createDiagnostic({ bus });
 * // ... run your agent ...
 * console.log(diag.format());
 * diag.dispose();
 * ```
 */
export const createDiagnostic = (
  opts: CreateDiagnosticOptions,
): {
  report(): DiagnosticReport;
  format(): string;
  dispose(): void;
} => {
  const eventsByType: Record<string, number> = {};
  let total = 0;
  let turns = 0;
  let toolCalls = 0;
  let denials = 0;
  const errors: Array<{ stage: string; message: string }> = [];

  // The bus has no removeInterceptor today, so dispose flips a flag and the
  // counter short-circuits. Negligible cost on a no-op interceptor.
  let disposed = false;
  opts.bus.use({
    name: 'harnesskit-diagnostic',
    on(event: AgentEvent) {
      if (disposed) return;
      total++;
      eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;
      if (event.type === 'turn.start') turns++;
      if (event.type === 'tool.call.requested') toolCalls++;
      if (event.type === 'tool.call.denied') denials++;
      if (event.type === 'error') {
        errors.push({ stage: event.stage, message: truncate(event.message) });
      }
    },
  });

  const buildReport = (): DiagnosticReport => {
    const fetchPatched = isPatched(opts.target);
    const warnings: string[] = [];
    const recommendations: string[] = [];

    if (!fetchPatched) {
      warnings.push(
        '`fetch` does not have the harnesskit patch marker — installFetchInterceptor was not called against this target.',
      );
      recommendations.push(
        'Call `installFetchInterceptor({ bus })` before issuing requests, or pass `target: { fetch: yourCustomFetch }` so the same custom target is patched.',
      );
    }

    if (total === 0 && fetchPatched) {
      warnings.push(
        'Bus is patched but no events have arrived. Either (a) no model API call was made, or (b) the URL host did not match any known provider so the call passed through unintercepted.',
      );
      recommendations.push(
        'If you use a proxy / gateway, add its host to `customHosts` (e.g. `customHosts: { openai: ["my-gateway.internal"] }`) and re-run.',
      );
    }

    if (fetchPatched && turns === 0 && total > 0) {
      warnings.push(
        'Saw events on the bus but zero turn.start. Either you only emitted custom events, or the URL of your fetch did not match a known provider host.',
      );
      recommendations.push(
        'If you use a proxy / gateway, add its host to `customHosts` (e.g. `customHosts: { openai: ["my-gateway.internal"] }`).',
      );
    }

    if (toolCalls > 0 && denials === 0) {
      // Not a warning — just a note that policies, if any, didn't fire.
      // Skipping; users who want denials will see them.
    }

    if (errors.length > 0) {
      warnings.push(`${errors.length} error event(s) observed — see report.errors.`);
    }

    return {
      fetchPatched,
      totalEvents: total,
      eventsByType: { ...eventsByType },
      turnsObserved: turns,
      toolCallsObserved: toolCalls,
      denials,
      errors: [...errors],
      warnings,
      recommendations,
    };
  };

  const formatReport = (): string => {
    const r = buildReport();
    const lines: string[] = [];
    lines.push('── harnesskit diagnostic ──');
    lines.push(`fetch patched:    ${r.fetchPatched ? '✓ yes' : '✗ NO'}`);
    lines.push(`total events:     ${r.totalEvents}`);
    lines.push(`turns observed:   ${r.turnsObserved}`);
    lines.push(`tool calls:       ${r.toolCallsObserved}`);
    lines.push(`denials:          ${r.denials}`);
    if (Object.keys(r.eventsByType).length > 0) {
      lines.push('events by type:');
      for (const [type, count] of Object.entries(r.eventsByType).sort()) {
        lines.push(`  ${type.padEnd(28)} ${count}`);
      }
    }
    if (r.errors.length > 0) {
      lines.push(`errors (${r.errors.length}):`);
      for (const e of r.errors) lines.push(`  [${e.stage}] ${e.message}`);
    }
    if (r.warnings.length > 0) {
      lines.push('warnings:');
      for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
    }
    if (r.recommendations.length > 0) {
      lines.push('recommendations:');
      for (const rec of r.recommendations) lines.push(`  → ${rec}`);
    }
    return lines.join('\n');
  };

  return {
    report: buildReport,
    format: formatReport,
    dispose: () => {
      disposed = true;
    },
  };
};
