export type Pattern = string | RegExp;

const escapeRegex = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export const matchPattern = (pattern: Pattern, input: string): boolean => {
  if (pattern instanceof RegExp) return pattern.test(input);
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === input;
  const re = new RegExp(`^${escapeRegex(pattern).replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(input);
};

export const matchAny = (patterns: readonly Pattern[], input: string): boolean =>
  patterns.some((p) => matchPattern(p, input));
