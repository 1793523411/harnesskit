import type { ToolResultRewriter } from '../types.js';
import type { ResponsesItem, ResponsesRequest } from './types.js';

export const applyDenyRewrites = (
  req: ResponsesRequest,
  deniedCalls: ReadonlyMap<string, string>,
): { rewritten: ResponsesRequest; rewroteIds: string[] } => {
  if (deniedCalls.size === 0) return { rewritten: req, rewroteIds: [] };
  if (typeof req.input === 'string') return { rewritten: req, rewroteIds: [] };

  const rewroteIds: string[] = [];
  let touched = false;
  const newInput: ResponsesItem[] = req.input.map((item) => {
    if (item.type !== 'function_call_output') return item;
    const callId = (item as { call_id?: string }).call_id;
    if (!callId) return item;
    const reason = deniedCalls.get(callId);
    if (!reason) return item;
    rewroteIds.push(callId);
    touched = true;
    return { ...item, output: `[harnesskit denied] ${reason}` };
  });
  return touched
    ? { rewritten: { ...req, input: newInput }, rewroteIds }
    : { rewritten: req, rewroteIds };
};

export const applyContentRewrites = (
  req: ResponsesRequest,
  rewriter: ToolResultRewriter,
): { rewritten: ResponsesRequest; rewroteIds: string[] } => {
  if (typeof req.input === 'string') return { rewritten: req, rewroteIds: [] };
  const rewroteIds: string[] = [];
  let touched = false;
  const newInput: ResponsesItem[] = req.input.map((item) => {
    if (item.type !== 'function_call_output') return item;
    const callId = (item as { call_id?: string }).call_id;
    const output = (item as { output?: string }).output;
    if (!callId || typeof output !== 'string') return item;
    const next = rewriter(output, { toolUseId: callId });
    if (next === undefined || next === output) return item;
    rewroteIds.push(callId);
    touched = true;
    return { ...item, output: next };
  });
  return touched
    ? { rewritten: { ...req, input: newInput }, rewroteIds }
    : { rewritten: req, rewroteIds };
};
