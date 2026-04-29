import type { ToolResultRewriter } from '../types.js';
import type { BedrockContentBlock, BedrockMessage, BedrockRequest } from './types.js';

const isToolResult = (
  b: BedrockContentBlock,
): b is {
  toolResult: {
    toolUseId: string;
    content: Array<{ text?: string; json?: unknown }>;
    status?: 'success' | 'error';
  };
} =>
  typeof (b as { toolResult?: unknown }).toolResult === 'object' &&
  (b as { toolResult?: unknown }).toolResult !== null;

export const applyDenyRewrites = (
  req: BedrockRequest,
  deniedCalls: ReadonlyMap<string, string>,
): { rewritten: BedrockRequest; rewroteIds: string[] } => {
  if (deniedCalls.size === 0) return { rewritten: req, rewroteIds: [] };
  const rewroteIds: string[] = [];
  let touched = false;
  const messages: BedrockMessage[] = req.messages.map((m) => {
    if (m.role !== 'user') return m;
    let msgTouched = false;
    const newContent = m.content.map((b) => {
      if (!isToolResult(b)) return b;
      const reason = deniedCalls.get(b.toolResult.toolUseId);
      if (!reason) return b;
      msgTouched = true;
      rewroteIds.push(b.toolResult.toolUseId);
      return {
        toolResult: {
          toolUseId: b.toolResult.toolUseId,
          content: [{ text: `[harnesskit denied] ${reason}` }],
          status: 'error' as const,
        },
      };
    });
    if (!msgTouched) return m;
    touched = true;
    return { ...m, content: newContent };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};

const stringifyContent = (
  parts: Array<{ text?: string; json?: unknown }>,
): string =>
  parts
    .map((p) => (typeof p.text === 'string' ? p.text : JSON.stringify(p.json ?? '')))
    .join('\n');

export const applyContentRewrites = (
  req: BedrockRequest,
  rewriter: ToolResultRewriter,
): { rewritten: BedrockRequest; rewroteIds: string[] } => {
  const rewroteIds: string[] = [];
  let touched = false;
  const messages: BedrockMessage[] = req.messages.map((m) => {
    if (m.role !== 'user') return m;
    let msgTouched = false;
    const newContent = m.content.map((b) => {
      if (!isToolResult(b)) return b;
      const text = stringifyContent(b.toolResult.content);
      const next = rewriter(text, { toolUseId: b.toolResult.toolUseId });
      if (next === undefined || next === text) return b;
      msgTouched = true;
      rewroteIds.push(b.toolResult.toolUseId);
      const out: typeof b = {
        toolResult: {
          toolUseId: b.toolResult.toolUseId,
          content: [{ text: next }],
        },
      };
      if (b.toolResult.status !== undefined) out.toolResult.status = b.toolResult.status;
      return out;
    });
    if (!msgTouched) return m;
    touched = true;
    return { ...m, content: newContent };
  });
  return touched ? { rewritten: { ...req, messages }, rewroteIds } : { rewritten: req, rewroteIds };
};
