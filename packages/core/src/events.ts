import type { AgentIds } from './ids.js';
import type {
  NormalizedRequest,
  NormalizedResponse,
  Provider,
  ToolCall,
  ToolResult,
  UsageInfo,
} from './normalized.js';

export type EventSource = 'l1' | 'l2';

interface BaseEvent {
  ts: number;
  ids: AgentIds;
  source: EventSource;
}

export interface SessionStartEvent extends BaseEvent {
  type: 'session.start';
  meta?: Record<string, unknown>;
}

export interface SessionEndEvent extends BaseEvent {
  type: 'session.end';
  reason: 'complete' | 'error' | 'abort';
}

export interface TurnStartEvent extends BaseEvent {
  type: 'turn.start';
  provider: Provider;
  model: string;
  request: NormalizedRequest;
  raw?: unknown;
}

export interface TurnEndEvent extends BaseEvent {
  type: 'turn.end';
  durationMs: number;
  response?: NormalizedResponse;
  raw?: unknown;
}

export interface ToolCallRequestedEvent extends BaseEvent {
  type: 'tool.call.requested';
  call: ToolCall;
}

export interface ToolCallResolvedEvent extends BaseEvent {
  type: 'tool.call.resolved';
  call: ToolCall;
  result: ToolResult;
}

export interface ToolCallDeniedEvent extends BaseEvent {
  type: 'tool.call.denied';
  call: ToolCall;
  reason: string;
  policyId?: string;
}

export interface UsageEvent extends BaseEvent {
  type: 'usage';
  usage: UsageInfo;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  stage: 'session' | 'turn.start' | 'turn.end' | 'tool.call' | 'policy' | 'interceptor' | 'unknown';
  cause?: unknown;
}

export interface SubagentSpawnEvent extends BaseEvent {
  type: 'subagent.spawn';
  parentSessionId: string;
  childSessionId: string;
  purpose?: string;
}

export interface SubagentReturnEvent extends BaseEvent {
  type: 'subagent.return';
  childSessionId: string;
  summary?: string;
}

export interface ApprovalRequestedEvent extends BaseEvent {
  type: 'approval.requested';
  call: ToolCall;
  pendingId: string;
}

export interface ApprovalResolvedEvent extends BaseEvent {
  type: 'approval.resolved';
  pendingId: string;
  decision: 'approve' | 'deny';
  by?: string;
}

export interface ContextCompactedEvent extends BaseEvent {
  type: 'context.compacted';
  beforeTokens?: number;
  afterTokens?: number;
}

export type AgentEvent =
  | SessionStartEvent
  | SessionEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ToolCallRequestedEvent
  | ToolCallResolvedEvent
  | ToolCallDeniedEvent
  | UsageEvent
  | ErrorEvent
  | SubagentSpawnEvent
  | SubagentReturnEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ContextCompactedEvent;

export type AgentEventType = AgentEvent['type'];

export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

export type GateableEvent = ToolCallRequestedEvent;
export const GATEABLE_TYPES = new Set<AgentEventType>(['tool.call.requested']);
export const isGateable = (e: AgentEvent): e is GateableEvent => GATEABLE_TYPES.has(e.type);
