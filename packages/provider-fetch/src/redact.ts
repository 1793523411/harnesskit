const STANDARD_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'openai-organization',
  'openai-project',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);

export type RedactOption =
  | 'all'
  | 'standard'
  | 'none'
  | ((name: string, value: string) => string | null);

export const redactHeaders = (
  headers: HeadersInit | undefined,
  opt: RedactOption = 'standard',
): Record<string, string> => {
  const obj: Record<string, string> = {};
  if (!headers) return obj;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      obj[k] = v;
    });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) obj[k] = v;
  } else {
    Object.assign(obj, headers);
  }
  if (opt === 'none') return obj;
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase();
    if (typeof opt === 'function') {
      const out = opt(k, v);
      if (out === null) delete obj[k];
      else obj[k] = out;
    } else if (opt === 'all') {
      obj[k] = '[REDACTED]';
    } else if (opt === 'standard' && STANDARD_HEADERS.has(lower)) {
      obj[k] = '[REDACTED]';
    }
  }
  return obj;
};
