import type { AgentEvent, GateableEvent, Policy, PolicyDecision, ToolCall } from '@harnesskit/core';
import { type Pattern, matchAny, matchPattern } from './match.js';
import { SessionState } from './state.js';

export const allowTools = (patterns: readonly Pattern[], id = 'allow-tools'): Policy => ({
  id,
  description: `allow only tools matching ${patterns.length} pattern(s)`,
  decide(e: GateableEvent): PolicyDecision {
    return matchAny(patterns, e.call.name)
      ? { allow: true }
      : { allow: false, reason: `tool "${e.call.name}" not in allowlist` };
  },
});

export const denyTools = (patterns: readonly Pattern[], id = 'deny-tools'): Policy => ({
  id,
  description: `block tools matching ${patterns.length} pattern(s)`,
  decide(e: GateableEvent): PolicyDecision {
    return matchAny(patterns, e.call.name)
      ? { allow: false, reason: `tool "${e.call.name}" is denied` }
      : { allow: true };
  },
});

export interface RequireApprovalOptions {
  match: Pattern | readonly Pattern[];
  approver: (call: ToolCall) => boolean | Promise<boolean>;
  id?: string;
}

export const requireApproval = (opts: RequireApprovalOptions): Policy => {
  const patterns: readonly Pattern[] = Array.isArray(opts.match)
    ? (opts.match as readonly Pattern[])
    : [opts.match as Pattern];
  return {
    id: opts.id ?? 'require-approval',
    description: `require human approval for tools matching ${patterns.length} pattern(s)`,
    async decide(e: GateableEvent): Promise<PolicyDecision> {
      if (!matchAny(patterns, e.call.name)) return { allow: true };
      const approved = await opts.approver(e.call);
      return approved
        ? { allow: true }
        : { allow: false, reason: `approval declined for "${e.call.name}"` };
    },
  };
};

export interface TokenBudget {
  input?: number;
  output?: number;
  total?: number;
}

export const tokenBudget = (limits: TokenBudget, id = 'token-budget'): Policy => {
  const state = new SessionState<{ input: number; output: number }>();
  const init = () => ({ input: 0, output: 0 });
  return {
    id,
    description: 'block when cumulative token usage exceeds budget',
    observe(e: AgentEvent) {
      if (e.type !== 'usage') return;
      const s = state.get(e.ids, init);
      s.input += e.usage.inputTokens ?? 0;
      s.output += e.usage.outputTokens ?? 0;
    },
    decide(e: GateableEvent): PolicyDecision {
      const s = state.get(e.ids, init);
      if (limits.input !== undefined && s.input > limits.input) {
        return {
          allow: false,
          reason: `input token budget ${limits.input} exceeded (${s.input})`,
        };
      }
      if (limits.output !== undefined && s.output > limits.output) {
        return {
          allow: false,
          reason: `output token budget ${limits.output} exceeded (${s.output})`,
        };
      }
      const total = s.input + s.output;
      if (limits.total !== undefined && total > limits.total) {
        return {
          allow: false,
          reason: `total token budget ${limits.total} exceeded (${total})`,
        };
      }
      return { allow: true };
    },
  };
};

export const maxToolCalls = (limit: number, id = 'max-tool-calls'): Policy => {
  const state = new SessionState<{ count: number }>();
  const init = () => ({ count: 0 });
  return {
    id,
    description: `block after ${limit} tool calls per session`,
    observe(e: AgentEvent) {
      if (e.type !== 'tool.call.resolved') return;
      const s = state.get(e.ids, init);
      s.count++;
    },
    decide(e: GateableEvent): PolicyDecision {
      const s = state.get(e.ids, init);
      if (s.count >= limit) {
        return { allow: false, reason: `tool call limit ${limit} reached` };
      }
      return { allow: true };
    },
  };
};

const getPath = (obj: unknown, path: string): unknown => {
  if (path === '') return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
};

export interface ArgRegexOptions {
  tool: Pattern;
  argPath: string;
  regex: RegExp;
  id?: string;
  description?: string;
}

export const argRegex = (opts: ArgRegexOptions): Policy => ({
  id: opts.id ?? `arg-regex:${opts.argPath}`,
  description:
    opts.description ?? `restrict ${opts.argPath} of matching tools to ${opts.regex.source}`,
  decide(e: GateableEvent): PolicyDecision {
    if (!matchPattern(opts.tool, e.call.name)) return { allow: true };
    const value = getPath(e.call.input, opts.argPath);
    if (typeof value !== 'string') {
      return {
        allow: false,
        reason: `tool "${e.call.name}" missing required string arg "${opts.argPath}"`,
      };
    }
    if (!opts.regex.test(value)) {
      return {
        allow: false,
        reason: `arg "${opts.argPath}" of "${e.call.name}" does not match ${opts.regex.source}`,
      };
    }
    return { allow: true };
  },
});

export interface HostnameAllowlistOptions {
  tool: Pattern;
  argPath: string;
  hosts: readonly string[];
  id?: string;
}

export const hostnameAllowlist = (opts: HostnameAllowlistOptions): Policy => ({
  id: opts.id ?? `hostname-allowlist:${opts.argPath}`,
  description: `restrict ${opts.argPath} hostname to ${opts.hosts.join(',')}`,
  decide(e: GateableEvent): PolicyDecision {
    if (!matchPattern(opts.tool, e.call.name)) return { allow: true };
    const value = getPath(e.call.input, opts.argPath);
    if (typeof value !== 'string') {
      return {
        allow: false,
        reason: `tool "${e.call.name}" missing required string arg "${opts.argPath}"`,
      };
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { allow: false, reason: `arg "${opts.argPath}" is not a valid URL: ${value}` };
    }
    const hostname = url.hostname.toLowerCase();
    const ok = opts.hosts.some((h) => {
      const lower = h.toLowerCase();
      return hostname === lower || hostname.endsWith(`.${lower}`);
    });
    return ok
      ? { allow: true }
      : { allow: false, reason: `hostname "${url.hostname}" not in allowlist` };
  },
});
