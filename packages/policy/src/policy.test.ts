import type { AgentEvent, ToolCallRequestedEvent, UsageEvent } from '@harnesskit/core';
import { EventBus } from '@harnesskit/core';
import { describe, expect, it } from 'vitest';
import {
  allOf,
  allowTools,
  anyOf,
  argRegex,
  combinePolicies,
  costBudget,
  denyTools,
  hostnameAllowlist,
  matchAny,
  matchPattern,
  maxToolCalls,
  outputContentRegex,
  outputPiiScan,
  piiScan,
  policy,
  policyToInterceptor,
  reasoningBudget,
  requireApproval,
  tokenBudget,
} from './index.js';

const ids = { sessionId: 's1', turnId: 't1' };

const toolEvt = (name: string, input: unknown = {}, callId = 'c1'): ToolCallRequestedEvent => ({
  type: 'tool.call.requested',
  ts: 1,
  ids,
  source: 'l1',
  call: { id: callId, name, input },
});

const usageEvt = (inputTokens: number, outputTokens: number): UsageEvent => ({
  type: 'usage',
  ts: 1,
  ids,
  source: 'l1',
  usage: { inputTokens, outputTokens },
});

describe('matchPattern', () => {
  it('handles exact strings, globs, and regex', () => {
    expect(matchPattern('shell', 'shell')).toBe(true);
    expect(matchPattern('shell', 'bash')).toBe(false);
    expect(matchPattern('read_*', 'read_file')).toBe(true);
    expect(matchPattern('read_*', 'write_file')).toBe(false);
    expect(matchPattern('*_file', 'read_file')).toBe(true);
    expect(matchPattern('a?c', 'abc')).toBe(true);
    expect(matchPattern('a?c', 'abbc')).toBe(false);
    expect(matchPattern(/^bash:/, 'bash:ls')).toBe(true);
    expect(matchPattern(/^bash:/, 'shell:ls')).toBe(false);
  });

  it('does not let glob escape special regex metachars', () => {
    expect(matchPattern('a.b', 'a.b')).toBe(true);
    expect(matchPattern('a.b', 'aXb')).toBe(false);
  });

  it('matchAny short-circuits on first hit', () => {
    expect(matchAny(['read_*', 'write_*'], 'write_file')).toBe(true);
    expect(matchAny(['read_*'], 'shell')).toBe(false);
    expect(matchAny([], 'shell')).toBe(false);
  });
});

describe('allowTools / denyTools', () => {
  it('allowTools allows only matching names', async () => {
    const p = allowTools(['read_*', /^bash:/]);
    expect(await p.decide(toolEvt('read_file'))).toEqual({ allow: true });
    expect(await p.decide(toolEvt('bash:ls'))).toEqual({ allow: true });
    const denied = await p.decide(toolEvt('write_file'));
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain('not in allowlist');
  });

  it('denyTools blocks matching names', async () => {
    const p = denyTools(['shell', 'exec_*']);
    expect(await p.decide(toolEvt('read_file'))).toEqual({ allow: true });
    const d = await p.decide(toolEvt('exec_python'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('denied');
  });
});

describe('requireApproval', () => {
  it('blocks tools that the approver rejects', async () => {
    let asked = '';
    const p = requireApproval({
      match: 'write_*',
      approver: (call) => {
        asked = call.name;
        return false;
      },
    });
    const d = await p.decide(toolEvt('write_file'));
    expect(d.allow).toBe(false);
    expect(asked).toBe('write_file');
  });

  it('lets non-matching tools through without asking', async () => {
    let asked = false;
    const p = requireApproval({
      match: 'write_*',
      approver: () => {
        asked = true;
        return true;
      },
    });
    const d = await p.decide(toolEvt('read_file'));
    expect(d.allow).toBe(true);
    expect(asked).toBe(false);
  });

  it('supports async approvers', async () => {
    const p = requireApproval({
      match: ['*'],
      approver: async () => true,
    });
    expect(await p.decide(toolEvt('anything'))).toEqual({ allow: true });
  });
});

describe('tokenBudget', () => {
  it('observes usage and denies when over budget', async () => {
    const p = tokenBudget({ output: 100 });
    expect(await p.decide(toolEvt('x'))).toEqual({ allow: true });
    await p.observe?.(usageEvt(10, 80));
    expect(await p.decide(toolEvt('x'))).toEqual({ allow: true });
    await p.observe?.(usageEvt(0, 30));
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('output token budget 100 exceeded (110)');
  });

  it('checks total budget independently', async () => {
    const p = tokenBudget({ total: 50 });
    await p.observe?.(usageEvt(30, 25));
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('total token budget 50 exceeded (55)');
  });

  it('keeps separate state per session', async () => {
    const p = tokenBudget({ output: 10 });
    await p.observe?.({ ...usageEvt(0, 100), ids: { sessionId: 'A', turnId: 't' } });
    const dB = await p.decide({
      ...toolEvt('x'),
      ids: { sessionId: 'B', turnId: 't' },
    });
    expect(dB).toEqual({ allow: true });
  });
});

describe('maxToolCalls', () => {
  it('counts resolved calls and stops at the limit', async () => {
    const p = maxToolCalls(2);
    expect(await p.decide(toolEvt('a'))).toEqual({ allow: true });
    const resolved = (callId: string): AgentEvent => ({
      type: 'tool.call.resolved',
      ts: 1,
      ids,
      source: 'l1',
      call: { id: callId, name: 'a', input: {} },
      result: { content: 'ok' },
    });
    await p.observe?.(resolved('c1'));
    await p.observe?.(resolved('c2'));
    const d = await p.decide(toolEvt('a'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('limit 2 reached');
  });
});

describe('argRegex', () => {
  it('blocks tools whose arg fails the regex', async () => {
    const p = argRegex({ tool: 'shell', argPath: 'cmd', regex: /^(ls|cat)/ });
    expect(await p.decide(toolEvt('shell', { cmd: 'ls -la' }))).toEqual({ allow: true });
    const d = await p.decide(toolEvt('shell', { cmd: 'rm -rf /' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('does not match');
  });

  it('skips tools that do not match', async () => {
    const p = argRegex({ tool: 'shell', argPath: 'cmd', regex: /^ls/ });
    expect(await p.decide(toolEvt('read_file', { cmd: 'rm' }))).toEqual({ allow: true });
  });

  it('supports nested arg paths', async () => {
    const p = argRegex({ tool: 'fetch', argPath: 'opts.method', regex: /^GET$/ });
    expect(await p.decide(toolEvt('fetch', { opts: { method: 'GET' } }))).toEqual({ allow: true });
    const d = await p.decide(toolEvt('fetch', { opts: { method: 'DELETE' } }));
    expect(d.allow).toBe(false);
  });

  it('denies when the arg is missing', async () => {
    const p = argRegex({ tool: 'shell', argPath: 'cmd', regex: /./ });
    const d = await p.decide(toolEvt('shell', {}));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('missing required string arg');
  });
});

describe('hostnameAllowlist', () => {
  it('allows exact and subdomain matches', async () => {
    const p = hostnameAllowlist({ tool: 'fetch', argPath: 'url', hosts: ['github.com'] });
    expect(await p.decide(toolEvt('fetch', { url: 'https://github.com/x' }))).toEqual({
      allow: true,
    });
    expect(await p.decide(toolEvt('fetch', { url: 'https://api.github.com/x' }))).toEqual({
      allow: true,
    });
    const d = await p.decide(toolEvt('fetch', { url: 'https://evil.com' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('not in allowlist');
  });

  it('rejects malformed URLs', async () => {
    const p = hostnameAllowlist({ tool: 'fetch', argPath: 'url', hosts: ['github.com'] });
    const d = await p.decide(toolEvt('fetch', { url: 'not a url' }));
    expect(d.allow).toBe(false);
  });
});

describe('piiScan', () => {
  it('blocks email by default', async () => {
    const p = piiScan();
    const d = await p.decide(toolEvt('webhook', { body: 'contact me at john@example.com' }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('john@example.com');
  });

  it('detects SSN in nested input', async () => {
    const p = piiScan({ patterns: ['ssn'] });
    const d = await p.decide(toolEvt('webhook', { user: { profile: { ssn: '123-45-6789' } } }));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('123-45-6789');
  });

  it('passes through clean input', async () => {
    const p = piiScan();
    expect(await p.decide(toolEvt('webhook', { body: 'just plain text' }))).toEqual({
      allow: true,
    });
  });

  it('respects tools allowlist (only scan webhook)', async () => {
    const p = piiScan({ tools: ['webhook'] });
    expect(await p.decide(toolEvt('echo', { body: 'a@b.com' }))).toEqual({ allow: true });
    const blocked = await p.decide(toolEvt('webhook', { body: 'a@b.com' }));
    expect(blocked.allow).toBe(false);
  });

  it('accepts custom RegExp patterns', async () => {
    const p = piiScan({ patterns: [/SECRET-\d+/] });
    const d = await p.decide(toolEvt('webhook', { body: 'token=SECRET-42' }));
    expect(d.allow).toBe(false);
  });

  it('walks arrays in input', async () => {
    const p = piiScan();
    const d = await p.decide(toolEvt('webhook', { recipients: ['ok@x.com', 'normal text'] }));
    expect(d.allow).toBe(false);
  });
});

describe('outputContentRegex', () => {
  it('emits error event when matched in tool result', async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.use({ on: (e) => void events.push(e) });
    bus.use(outputContentRegex({ pattern: /Bearer [A-Z0-9]+/ }));
    await bus.emit({
      type: 'tool.call.resolved',
      ts: 1,
      ids: { ...ids, callId: 'c' },
      source: 'l1',
      call: { id: 'c', name: 'fetch', input: {} },
      result: { content: 'header: Bearer ABC123XYZ' },
    });
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type !== 'error') throw new Error('wrong');
    expect(err.message).toContain('Bearer ABC123XYZ');
  });

  it('does not emit when no match', async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.use({ on: (e) => void events.push(e) });
    bus.use(outputContentRegex({ pattern: /SECRET/ }));
    await bus.emit({
      type: 'tool.call.resolved',
      ts: 1,
      ids: { ...ids, callId: 'c' },
      source: 'l1',
      call: { id: 'c', name: 'fetch', input: {} },
      result: { content: 'all clean' },
    });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

describe('outputPiiScan', () => {
  it('flags PII in tool output', async () => {
    const bus = new EventBus();
    const events: AgentEvent[] = [];
    bus.use({ on: (e) => void events.push(e) });
    bus.use(outputPiiScan({ patterns: ['email'] }));
    await bus.emit({
      type: 'tool.call.resolved',
      ts: 1,
      ids: { ...ids, callId: 'c' },
      source: 'l1',
      call: { id: 'c', name: 'fetch', input: {} },
      result: { content: 'user contact: alice@example.com' },
    });
    const err = events.find((e) => e.type === 'error');
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.message).toContain('alice@example.com');
  });
});

describe('costBudget', () => {
  it('observes usage cost and denies when exceeded', async () => {
    const p = costBudget({
      totalUsd: 0.005,
      pricer: (u) => (u.inputTokens ?? 0) * 0.000001 + (u.outputTokens ?? 0) * 0.00001,
    });
    expect(await p.decide(toolEvt('x'))).toEqual({ allow: true });
    await p.observe?.(usageEvt(1000, 500)); // $0.001 + $0.005 = $0.006 > $0.005
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('cost budget $0.005 exceeded');
  });

  it('falls back to usage.costUsd when no pricer provided', async () => {
    const p = costBudget({ totalUsd: 1 });
    await p.observe?.({
      type: 'usage',
      ts: 1,
      ids,
      source: 'l1',
      usage: { costUsd: 1.5 },
    });
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
  });
});

describe('reasoningBudget', () => {
  it('caps cumulative thinking content', async () => {
    const p = reasoningBudget({ chars: 100 });
    expect(await p.decide(toolEvt('x'))).toEqual({ allow: true });
    await p.observe?.({
      type: 'turn.end',
      ts: 1,
      ids,
      source: 'l1',
      durationMs: 0,
      response: {
        content: [{ type: 'thinking', text: 'x'.repeat(150) }],
      },
    });
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('reasoning budget 100 chars exceeded');
  });
});

describe('combinePolicies', () => {
  it('all-must-allow returns the first deny', async () => {
    const p = allOf([allowTools(['read_*']), denyTools(['read_secret'])]);
    expect(await p.decide(toolEvt('read_file'))).toEqual({ allow: true });
    const d = await p.decide(toolEvt('read_secret'));
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('denied');
  });

  it('any-allows succeeds if at least one allows', async () => {
    const p = anyOf([allowTools(['read_*']), allowTools(['shell'])]);
    expect(await p.decide(toolEvt('shell'))).toEqual({ allow: true });
    expect(await p.decide(toolEvt('read_file'))).toEqual({ allow: true });
    const d = await p.decide(toolEvt('write_file'));
    expect(d.allow).toBe(false);
  });

  it('any-allows with no policies is a deny', async () => {
    const p = combinePolicies([], 'any-allows');
    const d = await p.decide(toolEvt('x'));
    expect(d.allow).toBe(false);
  });

  it('observe propagates to all children', async () => {
    let countA = 0;
    let countB = 0;
    const p = allOf([
      { id: 'a', observe: () => void countA++, decide: () => ({ allow: true }) },
      { id: 'b', observe: () => void countB++, decide: () => ({ allow: true }) },
    ]);
    await p.observe?.(usageEvt(1, 1));
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });
});

describe('PolicyBuilder', () => {
  it('chains builtins and emits a single allOf policy', async () => {
    const p = policy()
      .denyTools(['shell'])
      .allowTools(['read_*', 'write_*'])
      .maxToolCalls(50)
      .build('test');

    expect(p.id).toBe('test');
    expect(await p.decide(toolEvt('read_file'))).toEqual({ allow: true });
    const denied = await p.decide(toolEvt('shell'));
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain('denied');
    const notInAllow = await p.decide(toolEvt('exec'));
    expect(notInAllow.allow).toBe(false);
    expect(notInAllow.reason).toContain('not in allowlist');
  });
});
