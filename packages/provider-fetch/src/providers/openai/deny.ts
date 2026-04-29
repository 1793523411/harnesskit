import type { ToolResultRewriter } from '../types.js';
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

const stringifyOpenAIToolContent = (content: OpenAIRequest['messages'][number]['content']): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text);
  }
  return parts.join('\n');
};

export const applyContentRewrites = (
  req: OpenAIRequest,
  rewriter: ToolResultRewriter,
): { rewritten: OpenAIRequest; rewroteIds: string[] } => {
  const rewroteIds: string[] = [];
  let touched = false;
  const messages = req.messages.map((m) => {
    if (m.role !== 'tool' || !m.tool_call_id) return m;
    const text = stringifyOpenAIToolContent(m.content ?? '');
    const next = rewriter(text, { toolUseId: m.tool_call_id });
    if (next === undefined || next === text) return m;
    rewroteIds.push(m.tool_call_id);
    touched = true;
    return { ...m, content: next };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};
