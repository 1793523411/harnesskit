const DEFAULT_HOSTS = new Set(['generativelanguage.googleapis.com']);

export interface GeminiDetectOptions {
  customHosts?: readonly string[];
}

const isGeneratePath = (pathname: string): boolean =>
  pathname.endsWith(':generateContent') || pathname.endsWith(':streamGenerateContent');

export const detectGemini = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: GeminiDetectOptions = {},
): boolean => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'POST') return false;
  let url: URL;
  try {
    if (typeof input === 'string') url = new URL(input);
    else if (input instanceof URL) url = input;
    else url = new URL(input.url);
  } catch {
    return false;
  }
  if (!isGeneratePath(url.pathname)) return false;
  const hosts = opts.customHosts ? new Set([...DEFAULT_HOSTS, ...opts.customHosts]) : DEFAULT_HOSTS;
  return hosts.has(url.host);
};

export const extractGeminiModelFromPath = (pathname: string): string | undefined => {
  const m = pathname.match(/\/models\/([^:]+):/);
  return m ? m[1] : undefined;
};

export const isStreamPath = (pathname: string): boolean =>
  pathname.endsWith(':streamGenerateContent');
