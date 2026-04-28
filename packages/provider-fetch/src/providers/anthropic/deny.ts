import type { AnthropicRequest } from './types.js';

export interface DenyRewriteResult {
  rewritten: AnthropicRequest;
  rewroteIds: string[];
}

export const applyDenyRewrites = (
  req: AnthropicRequest,
  deniedCalls: ReadonlyMap<string, string>,
): DenyRewriteResult => {
  if (deniedCalls.size === 0) return { rewritten: req, rewroteIds: [] };
  const rewroteIds: string[] = [];
  let touched = false;
  const messages = req.messages.map((m) => {
    if (typeof m.content === 'string' || m.role !== 'user') return m;
    let msgTouched = false;
    const newContent = m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      const reason = deniedCalls.get(b.tool_use_id);
      if (!reason) return b;
      msgTouched = true;
      rewroteIds.push(b.tool_use_id);
      return {
        type: 'tool_result' as const,
        tool_use_id: b.tool_use_id,
        is_error: true,
        content: `[harnesskit denied] ${reason}`,
      };
    });
    if (!msgTouched) return m;
    touched = true;
    return { ...m, content: newContent };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};
