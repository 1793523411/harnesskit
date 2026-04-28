import { randomUUID } from 'node:crypto';

export interface AgentIds {
  sessionId: string;
  turnId: string;
  callId?: string;
  agentPath?: readonly string[];
}

export const createSessionId = (): string => `sess_${randomUUID()}`;
export const createTurnId = (): string => `turn_${randomUUID()}`;
export const createCallId = (): string => `call_${randomUUID()}`;
export const createPendingId = (): string => `pend_${randomUUID()}`;
