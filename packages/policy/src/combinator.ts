import type { AgentEvent, GateableEvent, Policy, PolicyDecision } from '@harnesskit/core';

export type CombineMode = 'all-must-allow' | 'any-allows';

export const combinePolicies = (
  policies: readonly Policy[],
  mode: CombineMode = 'all-must-allow',
  id?: string,
): Policy => ({
  id: id ?? `combined:${mode}:${policies.map((p) => p.id).join('+')}`,
  async observe(e: AgentEvent) {
    await Promise.all(policies.map((p) => p.observe?.(e)));
  },
  async decide(e: GateableEvent): Promise<PolicyDecision> {
    if (mode === 'all-must-allow') {
      for (const p of policies) {
        const d = await p.decide(e);
        if (!d.allow) return d;
      }
      return { allow: true };
    }
    if (policies.length === 0) {
      return { allow: false, reason: 'no policies in any-allows combinator' };
    }
    let lastDeny: PolicyDecision = { allow: false, reason: 'no policy allowed' };
    for (const p of policies) {
      const d = await p.decide(e);
      if (d.allow) return d;
      lastDeny = d;
    }
    return lastDeny;
  },
});

export const allOf = (policies: readonly Policy[], id?: string): Policy =>
  combinePolicies(policies, 'all-must-allow', id);

export const anyOf = (policies: readonly Policy[], id?: string): Policy =>
  combinePolicies(policies, 'any-allows', id);
