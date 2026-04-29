import type { GeminiPart, GeminiRequest } from './types.js';

const synthIdForPart = (p: GeminiPart): string | undefined => {
  if (
    typeof (p as { functionResponse?: { id?: string; name?: string } }).functionResponse ===
    'object'
  ) {
    const fr = (p as { functionResponse: { id?: string; name?: string } }).functionResponse;
    return fr.id ?? (fr.name ? `gemini_fc_${fr.name}` : undefined);
  }
  return undefined;
};

export const applyDenyRewrites = (
  req: GeminiRequest,
  deniedCalls: ReadonlyMap<string, string>,
): { rewritten: GeminiRequest; rewroteIds: string[] } => {
  if (deniedCalls.size === 0) return { rewritten: req, rewroteIds: [] };
  const rewroteIds: string[] = [];
  let touched = false;
  const newContents = req.contents.map((c) => {
    if (c.role !== 'user') return c;
    let msgTouched = false;
    const newParts = c.parts.map((p) => {
      const id = synthIdForPart(p);
      if (!id) return p;
      const reason = deniedCalls.get(id);
      if (!reason) return p;
      const fr = (p as { functionResponse: { id?: string; name: string } }).functionResponse;
      rewroteIds.push(id);
      msgTouched = true;
      return {
        functionResponse: {
          ...(fr.id ? { id: fr.id } : {}),
          name: fr.name,
          response: { error: `[harnesskit denied] ${reason}` },
        },
      };
    });
    if (!msgTouched) return c;
    touched = true;
    return { ...c, parts: newParts };
  });
  return touched
    ? { rewritten: { ...req, contents: newContents }, rewroteIds }
    : { rewritten: req, rewroteIds };
};
