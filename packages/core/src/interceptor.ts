import type { AgentEvent } from './events.js';

export interface DenyDecision {
  reason: string;
  policyId?: string;
}

export interface InterceptorContext {
  /**
   * Emit a follow-up event into the bus.
   * Use sparingly — primarily for L2 adapters injecting semantic events.
   */
  emit(event: AgentEvent): void | Promise<void>;

  /**
   * Block the current event from proceeding. Only meaningful for gateable events
   * (currently `tool.call.requested`). Calling on a non-gateable event is a no-op
   * with a one-line warning.
   *
   * The first interceptor to call deny() wins; downstream interceptors still see
   * the original event but the bus reports the decision back to the caller.
   */
  deny(reason: string, policyId?: string): void;

  /**
   * Abort signal tied to the current dispatch. Long-running async interceptors
   * should respect this to avoid leaking work past session end.
   */
  signal: AbortSignal;
}

export interface Interceptor {
  /** Optional name for debugging / trace attribution. */
  name?: string;

  /** Called once when registered with the bus. */
  init?(): void | Promise<void>;

  /** Receive every event. May call ctx.deny() on gateable events. */
  on(event: AgentEvent, ctx: InterceptorContext): void | Promise<void>;

  /** Called when the bus is disposed. */
  dispose?(): void | Promise<void>;
}
