import type { ToolResultRewriter } from '../types.js';
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

const rewriteStringsInValue = (
  v: unknown,
  apply: (s: string) => string | undefined,
): { value: unknown; touched: boolean } => {
  if (typeof v === 'string') {
    const next = apply(v);
    if (next === undefined || next === v) return { value: v, touched: false };
    return { value: next, touched: true };
  }
  if (Array.isArray(v)) {
    let arrTouched = false;
    const out = v.map((x) => {
      const r = rewriteStringsInValue(x, apply);
      if (r.touched) arrTouched = true;
      return r.value;
    });
    return arrTouched ? { value: out, touched: true } : { value: v, touched: false };
  }
  if (v && typeof v === 'object') {
    let objTouched = false;
    const obj: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>)) {
      const r = rewriteStringsInValue((v as Record<string, unknown>)[key], apply);
      obj[key] = r.value;
      if (r.touched) objTouched = true;
    }
    return objTouched ? { value: obj, touched: true } : { value: v, touched: false };
  }
  return { value: v, touched: false };
};

export const applyContentRewrites = (
  req: GeminiRequest,
  rewriter: ToolResultRewriter,
): { rewritten: GeminiRequest; rewroteIds: string[] } => {
  const rewroteIds: string[] = [];
  let touched = false;
  const newContents = req.contents.map((c) => {
    if (c.role !== 'user') return c;
    let msgTouched = false;
    const newParts = c.parts.map((p) => {
      const fr = (p as { functionResponse?: { id?: string; name?: string; response?: unknown } })
        .functionResponse;
      if (!fr) return p;
      const id = fr.id ?? (fr.name ? `gemini_fc_${fr.name}` : undefined);
      if (!id) return p;
      const { value, touched: partTouched } = rewriteStringsInValue(fr.response, (s) =>
        rewriter(s, { toolUseId: id }),
      );
      if (!partTouched) return p;
      rewroteIds.push(id);
      msgTouched = true;
      return {
        functionResponse: {
          ...(fr.id ? { id: fr.id } : {}),
          ...(fr.name ? { name: fr.name } : {}),
          response: value,
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
