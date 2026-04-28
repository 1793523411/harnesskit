import type { AgentEvent, GateableEvent } from './events.js';
import type { Interceptor, InterceptorContext } from './interceptor.js';

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

/**
 * A Policy is a narrowed Interceptor focused on gating decisions.
 * It's syntactic sugar — under the hood it's adapted into an Interceptor.
 *
 * Implementations live in `@harnesskit/policy`; the interface lives here so
 * any package can produce a Policy without depending on the policy package.
 */
export interface Policy {
  readonly id: string;
  readonly description?: string;

  /**
   * Inspect any event for context (e.g., remembering a recent request to inform
   * a later tool-call decision). Optional.
   */
  observe?(event: AgentEvent): void | Promise<void>;

  /**
   * Decide whether to allow a gateable event. Returning `{ allow: false }`
   * causes the bus to deny the event with the given reason.
   */
  decide(event: GateableEvent): PolicyDecision | Promise<PolicyDecision>;
}

export const policyToInterceptor = (policy: Policy): Interceptor => ({
  name: `policy:${policy.id}`,
  async on(event: AgentEvent, ctx: InterceptorContext) {
    await policy.observe?.(event);
    if (event.type === 'tool.call.requested') {
      const decision = await policy.decide(event);
      if (!decision.allow) {
        ctx.deny(decision.reason ?? `denied by policy ${policy.id}`, policy.id);
      }
    }
  },
});
