/**
 * Subset of the Claude Agent SDK option surface that we touch.
 * Mirrors @anthropic-ai/claude-agent-sdk types so this package can be used
 * without taking a hard dependency on the SDK.
 */

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest';

export interface BaseHookInput {
  hook_event_name: HookEvent;
  session_id?: string;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  duration_ms?: number;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
}

export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
}

export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStart';
  parent_session_id?: string;
  child_session_id?: string;
  agent_type?: string;
  prompt?: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStop';
  child_session_id?: string;
  result?: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | PreCompactHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | (BaseHookInput & { [key: string]: unknown });

export type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | {
        hookEventName: 'PreToolUse';
        permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
        additionalContext?: string;
      }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'Stop'; additionalContext?: string }
    | { hookEventName: 'PreCompact'; additionalContext?: string };
};

export type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
};

export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID: string;
    agentID?: string;
    blockedPath?: string;
    decisionReason?: string;
  },
) => Promise<PermissionResult>;

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export interface ClaudeAgentSdkOptions {
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool?: CanUseTool;
  [key: string]: unknown;
}
