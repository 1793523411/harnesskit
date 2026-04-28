import type { OpenAIRequest } from './types.js';

export const applyDenyRewrites = (
  req: OpenAIRequest,
  deniedCalls: ReadonlyMap<string, string>,
): { rewritten: OpenAIRequest; rewroteIds: string[] } => {
  if (deniedCalls.size === 0) return { rewritten: req, rewroteIds: [] };
  const rewroteIds: string[] = [];
  let touched = false;
  const messages = req.messages.map((m) => {
    if (m.role !== 'tool' || !m.tool_call_id) return m;
    const reason = deniedCalls.get(m.tool_call_id);
    if (!reason) return m;
    rewroteIds.push(m.tool_call_id);
    touched = true;
    return { ...m, content: `[harnesskit denied] ${reason}` };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};
