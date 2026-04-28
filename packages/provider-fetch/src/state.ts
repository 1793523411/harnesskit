export interface InterceptorState {
  /** tool_use_id -> deny reason (consumed on next outgoing tool_result) */
  deniedCalls: Map<string, string>;
}

export const createState = (): InterceptorState => ({
  deniedCalls: new Map(),
});
