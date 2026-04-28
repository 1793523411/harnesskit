/**
 * Subset of the @openai/agents RunHooks shape that we touch.
 * Mirrors the EventEmitter-based lifecycle in @openai/agents-core/lifecycle.
 */

export interface ToolCallItemLike {
  id?: string;
  name?: string;
  arguments?: unknown;
  [key: string]: unknown;
}

export interface ToolLike {
  name?: string;
  [key: string]: unknown;
}

export interface AgentLike {
  name?: string;
  [key: string]: unknown;
}

export type RunHooksListener = (...args: unknown[]) => void;

export interface RunHooksLike {
  on(eventName: string, listener: RunHooksListener): unknown;
  off(eventName: string, listener: RunHooksListener): unknown;
}
