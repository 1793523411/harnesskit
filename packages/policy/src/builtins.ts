import type {
  AgentEvent,
  GateableEvent,
  Interceptor,
  Policy,
  PolicyDecision,
  ToolCall,
  UsageInfo,
} from '@harnesskit/core';
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

export type PiiPatternName = 'email' | 'ssn' | 'creditcard' | 'phone' | 'ipv4';

const PII_REGEXES: Record<PiiPatternName, RegExp> = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  creditcard: /\b(?:\d[ -]?){13,19}\b/,
  // Negative lookbehind for digit/dash so we don't grab middle of "1234567890123";
  // negative lookahead for digit so trailing digits don't extend the match.
  // Allows optional parens around area code: "(415) 555-0142", "415-555-0142", etc.
  phone: /(?<![\d-])\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}(?!\d)/,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
};

export interface PiiScanOptions {
  /** Patterns to scan for. Default: ['email', 'ssn', 'creditcard']. */
  patterns?: readonly (PiiPatternName | RegExp)[];
  /** Tools to scan. Default: all. */
  tools?: readonly Pattern[];
  id?: string;
}

const scanString = (
  s: string,
  regexes: readonly RegExp[],
): { matched: string; pattern: RegExp } | undefined => {
  for (const re of regexes) {
    const m = s.match(re);
    if (m) return { matched: m[0], pattern: re };
  }
  return undefined;
};

const scanValue = (
  v: unknown,
  regexes: readonly RegExp[],
): { matched: string; pattern: RegExp } | undefined => {
  if (typeof v === 'string') return scanString(v, regexes);
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = scanValue(item, regexes);
      if (r) return r;
    }
  } else if (v && typeof v === 'object') {
    for (const key of Object.keys(v as Record<string, unknown>)) {
      const r = scanValue((v as Record<string, unknown>)[key], regexes);
      if (r) return r;
    }
  }
  return undefined;
};

export const piiScan = (opts: PiiScanOptions = {}): Policy => {
  const patternList: readonly (PiiPatternName | RegExp)[] = opts.patterns ?? [
    'email',
    'ssn',
    'creditcard',
  ];
  const regexes: RegExp[] = patternList.map((p) => (p instanceof RegExp ? p : PII_REGEXES[p]));
  const toolPatterns = opts.tools ?? ['*'];
  return {
    id: opts.id ?? 'pii-scan',
    description: `block tool inputs containing PII matches (${patternList
      .map((p) => (p instanceof RegExp ? p.source : p))
      .join(',')})`,
    decide(e: GateableEvent): PolicyDecision {
      if (!toolPatterns.some((tp) => matchPattern(tp, e.call.name))) return { allow: true };
      const hit = scanValue(e.call.input, regexes);
      if (hit) {
        return {
          allow: false,
          reason: `tool input matches PII pattern (${hit.pattern.source}): "${hit.matched}"`,
        };
      }
      return { allow: true };
    },
  };
};

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

// ── Output observers (Interceptors, audit-only) ────────────────────────

const stringifyResultContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const part = b as { type?: string; text?: string };
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(content);
};

export interface OutputContentRegexOptions {
  pattern: RegExp;
  message?: string;
  tools?: readonly Pattern[];
  name?: string;
}

/**
 * Observes tool.call.resolved content and emits an `error` event when it
 * matches the regex. Audit-only — does not block the call (the result has
 * already arrived). Use to flag secret leaks, prompt injection markers, etc.
 */
export const outputContentRegex = (opts: OutputContentRegexOptions): Interceptor => {
  const toolPatterns = opts.tools ?? ['*'];
  return {
    name: opts.name ?? 'output-content-regex',
    on(event, ctx) {
      if (event.type !== 'tool.call.resolved') return;
      if (!toolPatterns.some((tp) => matchPattern(tp, event.call.name))) return;
      const content = stringifyResultContent(event.result.content);
      const m = content.match(opts.pattern);
      if (m) {
        void ctx.emit({
          type: 'error',
          ts: Date.now(),
          ids: event.ids,
          source: event.source,
          message:
            opts.message ??
            `tool "${event.call.name}" output matched ${opts.pattern.source}: ${m[0]}`,
          stage: 'tool.call',
        });
      }
    },
  };
};

export interface OutputPiiScanOptions {
  patterns?: readonly (PiiPatternName | RegExp)[];
  tools?: readonly Pattern[];
  name?: string;
}

export interface RedactPiiInToolResultsOptions {
  patterns?: readonly (PiiPatternName | RegExp)[];
  /** What to swap matches with. Default: "[REDACTED]". */
  replacement?: string;
  /**
   * Optional filter — toolUseId-based. If a `lookup` is given, the rewriter
   * can short-circuit calls it doesn't care about. Default: rewrite all.
   */
  lookup?: (ctx: { toolUseId: string }) => boolean;
  /**
   * Optional callback fired once per tool_result that produced redactions.
   * Receives the matched substrings (one entry per pattern that fired) so
   * you can log, count, or push an audit event onto your own bus.
   */
  audit?: (info: { toolUseId: string; matches: Array<{ pattern: string; matched: string[] }> }) => void;
}

/**
 * Returns a tool-result content rewriter for use with
 * `installFetchInterceptor({ rewriteToolResults })`. Actively redacts PII
 * matches in outgoing-from-tool content before the model sees it.
 *
 * Unlike {@link outputPiiScan} (audit-only) this *modifies the wire payload*.
 * Pair with {@link piiScan} to also block PII *into* tool calls.
 */
export const redactPiiInToolResults = (
  opts: RedactPiiInToolResultsOptions = {},
): ((content: string, ctx: { toolUseId: string }) => string | undefined) => {
  const patternList: readonly (PiiPatternName | RegExp)[] = opts.patterns ?? [
    'email',
    'ssn',
    'creditcard',
  ];
  const withGlobal = (re: RegExp): RegExp => {
    const flags = [...new Set(`${re.flags}g`.split(''))].join('');
    return new RegExp(re.source, flags);
  };
  const regexes: RegExp[] = patternList.map((p) =>
    withGlobal(p instanceof RegExp ? p : PII_REGEXES[p]),
  );
  const replacement = opts.replacement ?? '[REDACTED]';
  return (content, ctx) => {
    if (opts.lookup && !opts.lookup(ctx)) return undefined;
    let out = content;
    let hit = false;
    const auditMatches: Array<{ pattern: string; matched: string[] }> = [];
    for (const re of regexes) {
      // matchAll captures occurrences before we mutate `out` with replace()
      const found = [...out.matchAll(re)].map((m) => m[0]);
      if (found.length === 0) continue;
      hit = true;
      // Reset regex state — we're about to use replace which scans from 0
      re.lastIndex = 0;
      out = out.replace(re, replacement);
      if (opts.audit) auditMatches.push({ pattern: re.source, matched: found });
    }
    if (hit && opts.audit) {
      try {
        opts.audit({ toolUseId: ctx.toolUseId, matches: auditMatches });
      } catch {
        // Audit must never break redaction
      }
    }
    return hit ? out : undefined;
  };
};

/**
 * Like {@link piiScan} but observes outgoing-from-tool content (i.e. what
 * the model is about to see). Audit-only — emits `error` events. Pair with
 * {@link piiScan} to cover both directions.
 */
export const outputPiiScan = (opts: OutputPiiScanOptions = {}): Interceptor => {
  const patternList: readonly (PiiPatternName | RegExp)[] = opts.patterns ?? [
    'email',
    'ssn',
    'creditcard',
  ];
  const regexes: RegExp[] = patternList.map((p) => (p instanceof RegExp ? p : PII_REGEXES[p]));
  const toolPatterns = opts.tools ?? ['*'];
  return {
    name: opts.name ?? 'output-pii-scan',
    on(event, ctx) {
      if (event.type !== 'tool.call.resolved') return;
      if (!toolPatterns.some((tp) => matchPattern(tp, event.call.name))) return;
      const content = stringifyResultContent(event.result.content);
      const hit = scanString(content, regexes);
      if (hit) {
        void ctx.emit({
          type: 'error',
          ts: Date.now(),
          ids: event.ids,
          source: event.source,
          message: `PII in tool "${event.call.name}" output (${hit.pattern.source}): ${hit.matched}`,
          stage: 'tool.call',
        });
      }
    },
  };
};

// ── Cost & reasoning budgets ───────────────────────────────────────────

export type CostPricer = (usage: UsageInfo) => number;

export interface CostBudgetOptions {
  totalUsd: number;
  /**
   * Compute cost from a UsageInfo. Default reads `usage.costUsd` if present,
   * else 0 (no enforcement). Most users provide a per-token pricer.
   */
  pricer?: CostPricer;
  id?: string;
}

const defaultPricer: CostPricer = (u) => u.costUsd ?? 0;

export const costBudget = (opts: CostBudgetOptions): Policy => {
  const state = new SessionState<{ usd: number }>();
  const init = () => ({ usd: 0 });
  const pricer = opts.pricer ?? defaultPricer;
  return {
    id: opts.id ?? 'cost-budget',
    description: `block tool calls when cumulative session cost exceeds $${opts.totalUsd}`,
    observe(e: AgentEvent) {
      if (e.type !== 'usage') return;
      const s = state.get(e.ids, init);
      s.usd += pricer(e.usage);
    },
    decide(e: GateableEvent): PolicyDecision {
      const s = state.get(e.ids, init);
      if (s.usd > opts.totalUsd) {
        return {
          allow: false,
          reason: `cost budget $${opts.totalUsd} exceeded ($${s.usd.toFixed(4)})`,
        };
      }
      return { allow: true };
    },
  };
};

export interface ReasoningBudgetOptions {
  chars: number;
  id?: string;
}

// ── Rate limiting ──────────────────────────────────────────────────────

interface SlidingEntry {
  ts: number;
  value: number;
}

class SlidingWindow {
  private entries: SlidingEntry[] = [];

  add(ts: number, value: number): void {
    this.entries.push({ ts, value });
  }

  sumWithin(now: number, windowMs: number): number {
    const cutoff = now - windowMs;
    let i = 0;
    while (i < this.entries.length && this.entries[i]!.ts < cutoff) i++;
    if (i > 0) this.entries.splice(0, i);
    let total = 0;
    for (const e of this.entries) total += e.value;
    return total;
  }
}

export interface RateLimitOptions {
  /** Max input + output tokens per rolling 60s window. */
  tokensPerMin?: number;
  /** Max model API calls (turn.start) per rolling 60s window. */
  requestsPerMin?: number;
  /** Override the rolling window length. Default 60_000ms. */
  windowMs?: number;
  /**
   * Default reads `Date.now()`. Override for deterministic tests or to use a
   * monotonic clock. Receives nothing, returns current ms timestamp.
   */
  now?: () => number;
  id?: string;
}

/**
 * Sliding-window rate limit. Tracks token usage (from `usage` events) and
 * request count (from `turn.start` events) over a rolling window — by default
 * 60s. When a `tool.call.requested` would push the agent past either cap on
 * the *next* turn, denies the call.
 *
 * Why deny on tool.call.requested specifically: the agent loop runs a tool
 * call → next turn. Denying the tool call is the closest we can get to "stop
 * before issuing another model API call" with the events we already have.
 *
 * Use alongside or instead of `tokenBudget` (which caps totals, not rate).
 */
export const rateLimit = (opts: RateLimitOptions): Policy => {
  if (opts.tokensPerMin === undefined && opts.requestsPerMin === undefined) {
    throw new Error('rateLimit: at least one of tokensPerMin / requestsPerMin must be set');
  }
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const tokenWindow = new SlidingWindow();
  const requestWindow = new SlidingWindow();
  return {
    id: opts.id ?? 'rate-limit',
    description: `${opts.tokensPerMin ?? '∞'} tokens/${opts.requestsPerMin ?? '∞'} requests per ${windowMs}ms window`,
    observe(e: AgentEvent) {
      if (e.type === 'usage') {
        const total = (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0);
        if (total > 0) tokenWindow.add(now(), total);
      } else if (e.type === 'turn.start') {
        requestWindow.add(now(), 1);
      }
    },
    decide(_e: GateableEvent): PolicyDecision {
      const t = now();
      if (opts.tokensPerMin !== undefined) {
        const used = tokenWindow.sumWithin(t, windowMs);
        if (used >= opts.tokensPerMin) {
          return {
            allow: false,
            reason: `rate limit: ${used} tokens used in last ${windowMs}ms (cap ${opts.tokensPerMin})`,
          };
        }
      }
      if (opts.requestsPerMin !== undefined) {
        const used = requestWindow.sumWithin(t, windowMs);
        if (used >= opts.requestsPerMin) {
          return {
            allow: false,
            reason: `rate limit: ${used} requests in last ${windowMs}ms (cap ${opts.requestsPerMin})`,
          };
        }
      }
      return { allow: true };
    },
  };
};

/**
 * Caps cumulative reasoning-block character count per session. Useful against
 * runaway chain-of-thought from reasoning models.
 */
export const reasoningBudget = (opts: ReasoningBudgetOptions): Policy => {
  const state = new SessionState<{ chars: number }>();
  const init = () => ({ chars: 0 });
  return {
    id: opts.id ?? 'reasoning-budget',
    description: `block tool calls when cumulative reasoning exceeds ${opts.chars} chars`,
    observe(e: AgentEvent) {
      if (e.type !== 'turn.end') return;
      const blocks = e.response?.content ?? [];
      const s = state.get(e.ids, init);
      for (const b of blocks) {
        if (b.type === 'thinking') s.chars += b.text.length;
      }
    },
    decide(e: GateableEvent): PolicyDecision {
      const s = state.get(e.ids, init);
      if (s.chars > opts.chars) {
        return {
          allow: false,
          reason: `reasoning budget ${opts.chars} chars exceeded (${s.chars})`,
        };
      }
      return { allow: true };
    },
  };
};
