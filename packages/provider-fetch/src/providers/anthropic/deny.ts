import type { ToolResultRewriter } from '../types.js';
import type { AnthropicContentBlock, AnthropicRequest } from './types.js';

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

const stringifyAnthropicResultContent = (
  content: string | AnthropicContentBlock[],
): { text: string; multipart: boolean } => {
  if (typeof content === 'string') return { text: content, multipart: false };
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text') parts.push(b.text);
  }
  return { text: parts.join('\n'), multipart: true };
};

export const applyContentRewrites = (
  req: AnthropicRequest,
  rewriter: ToolResultRewriter,
): { rewritten: AnthropicRequest; rewroteIds: string[] } => {
  const rewroteIds: string[] = [];
  let touched = false;
  const messages = req.messages.map((m) => {
    if (typeof m.content === 'string' || m.role !== 'user') return m;
    let msgTouched = false;
    const newContent = m.content.map((b) => {
      if (b.type !== 'tool_result') return b;
      const { text, multipart } = stringifyAnthropicResultContent(b.content);
      const next = rewriter(text, { toolUseId: b.tool_use_id });
      if (next === undefined || next === text) return b;
      msgTouched = true;
      rewroteIds.push(b.tool_use_id);
      // Preserve original shape: if input was multipart, write back a single
      // text block. The model treats this identically.
      const newInner: string | AnthropicContentBlock[] = multipart
        ? [{ type: 'text' as const, text: next }]
        : next;
      const out: typeof b = {
        type: 'tool_result' as const,
        tool_use_id: b.tool_use_id,
        content: newInner,
      };
      if (b.is_error !== undefined) out.is_error = b.is_error;
      return out;
    });
    if (!msgTouched) return m;
    touched = true;
    return { ...m, content: newContent };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};
