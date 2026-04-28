# Policies

A policy decides whether a `tool.call.requested` event should be allowed. `@harnesskit/policy` ships seven builtins, an `allOf`/`anyOf` combinator, and a fluent builder.

## Shape

```ts
interface Policy {
  readonly id: string;
  readonly description?: string;
  observe?(event: AgentEvent): void | Promise<void>;       // (optional) collect state from any event
  decide(event: GateableEvent): PolicyDecision | Promise<PolicyDecision>;
}

type PolicyDecision = { allow: true } | { allow: false; reason: string };
```

`policyToInterceptor(policy)` registers it on a bus. The first deny wins; later interceptors still see the event but can't overturn it.

```ts
import { policyToInterceptor, denyTools } from '@harnesskit/policy';
bus.use(policyToInterceptor(denyTools(['shell'])));
```

## Builtins

### `allowTools(patterns)` / `denyTools(patterns)`

Allow- or deny-list by tool name. Patterns can be exact strings, glob (`*`/`?`), or `RegExp`.

```ts
allowTools(['read_*', '*_file', /^bash:/]);
denyTools(['shell', 'exec_*']);
```

### `requireApproval({ match, approver })`

Synchronous human-in-the-loop. The async `approver` is awaited; returning `false` denies.

```ts
requireApproval({
  match: ['write_*', 'delete_*'],
  approver: async (call) => askHuman(`Run ${call.name}?`, call.input),
});
```

### `tokenBudget({ input?, output?, total? })`

Tracks `usage` events per-session. Denies when any limit is exceeded.

```ts
tokenBudget({ output: 50_000 });
tokenBudget({ total: 200_000 });
```

### `maxToolCalls(limit)`

Caps the number of *resolved* tool calls per session.

```ts
maxToolCalls(20);
```

### `argRegex({ tool, argPath, regex })`

Validates a string argument against a regex. `argPath` is a dot path (`'cmd'`, `'opts.method'`).

```ts
argRegex({
  tool: 'shell',
  argPath: 'cmd',
  regex: /^(ls|cat|grep)\b/,
});
```

### `hostnameAllowlist({ tool, argPath, hosts })`

For tools that take URLs — restricts the hostname. Subdomains of allowed hosts are allowed too.

```ts
hostnameAllowlist({
  tool: 'fetch',
  argPath: 'url',
  hosts: ['github.com', 'docs.python.org'],
});
// allows  https://api.github.com/...
// denies  https://evil.com/...
```

### `piiScan({ patterns?, tools?, id? })`

Recursively scans the `input` of tool calls for PII patterns. Supports built-in pattern names and arbitrary `RegExp`. Default: `['email', 'ssn', 'creditcard']` across all tools.

```ts
import { piiScan } from '@harnesskit/policy';

piiScan();  // defaults: email + ssn + creditcard, all tools

piiScan({ patterns: ['email', 'phone', 'ipv4'] });

piiScan({
  patterns: ['email', 'ssn', /SECRET-[A-Z0-9]+/],
  tools: ['send_webhook', 'http_*'],   // only scan these tools
});
```

Built-in pattern names: `'email' | 'ssn' | 'creditcard' | 'phone' | 'ipv4'`. Returns the matched string in the deny reason for debugging — be careful when surfacing reasons in logs.

## Combinators

### `allOf(policies)` — every policy must allow

```ts
import { allOf, allowTools, tokenBudget } from '@harnesskit/policy';
const p = allOf([allowTools(['read_*']), tokenBudget({ output: 10_000 })]);
```

### `anyOf(policies)` — at least one must allow

```ts
import { anyOf, allowTools } from '@harnesskit/policy';
// "allow read_* OR write_to_tmp"
const p = anyOf([allowTools(['read_*']), allowTools(['write_to_tmp'])]);
```

## The fluent builder

```ts
import { policy } from '@harnesskit/policy';

const guard = policy()
  .denyTools(['shell', 'exec_*'])
  .allowTools(['read_*', 'write_*'])
  .tokenBudget({ output: 50_000 })
  .maxToolCalls(20)
  .argRegex({ tool: 'shell', argPath: 'cmd', regex: /^(ls|cat)/ })
  .hostnameAllowlist({ tool: 'fetch', argPath: 'url', hosts: ['github.com'] })
  .build('production-guard');

bus.use(policyToInterceptor(guard));
```

`.build(id)` produces a single composed policy via `allOf`. To compose with `anyOf` semantics or mix combinator modes, build sub-policies and combine manually.

## Pattern matching reference

`matchPattern(pattern, input)` and `matchAny(patterns, input)` are exported for use in custom policies.

| Pattern | Matches |
| --- | --- |
| `'shell'` | exact `shell` |
| `'read_*'` | `read_file`, `read_anything` |
| `'a?c'` | `abc`, `axc`, NOT `abbc` |
| `/^bash:/` | anything starting with `bash:` |
| `'a.b'` | exact `a.b` (`.` is escaped, not regex meta) |

## Writing a custom policy

```ts
import type { Policy } from '@harnesskit/policy';

const noShellOnFriday: Policy = {
  id: 'no-shell-friday',
  decide(event) {
    const isFriday = new Date().getDay() === 5;
    if (event.call.name === 'shell' && isFriday) {
      return { allow: false, reason: 'no shell on Friday — incident week' };
    }
    return { allow: true };
  },
};
```

For policies that need to remember state across events (like `tokenBudget`), use the optional `observe` hook and the `SessionState` helper:

```ts
import type { Policy } from '@harnesskit/policy';
import { SessionState } from '@harnesskit/policy';

const recentReadBytesByPath = new SessionState<Map<string, number>>();

export const fileReadBudget = (limitBytes: number): Policy => ({
  id: 'file-read-budget',
  observe(event) {
    if (event.type === 'tool.call.resolved' && event.call.name === 'read_file') {
      const m = recentReadBytesByPath.get(event.ids, () => new Map());
      const path = (event.call.input as { path?: string })?.path ?? '?';
      const bytes = typeof event.result.content === 'string' ? event.result.content.length : 0;
      m.set(path, (m.get(path) ?? 0) + bytes);
    }
  },
  decide(event) {
    if (event.call.name !== 'read_file') return { allow: true };
    const m = recentReadBytesByPath.get(event.ids, () => new Map());
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return total > limitBytes
      ? { allow: false, reason: `cumulative read budget ${limitBytes} exceeded (${total})` }
      : { allow: true };
  },
});
```

## Test your policies in isolation

A policy's `decide` is a pure function. You can unit-test it without spinning up a bus:

```ts
import { describe, expect, it } from 'vitest';
import { denyTools } from '@harnesskit/policy';

it('denies shell', async () => {
  const p = denyTools(['shell']);
  const result = await p.decide({
    type: 'tool.call.requested',
    ts: 0,
    ids: { sessionId: 's', turnId: 't', callId: 'c' },
    source: 'l1',
    call: { id: 'c', name: 'shell', input: {} },
  });
  expect(result.allow).toBe(false);
});
```
