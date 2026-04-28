const OPENAI_DEFAULT_HOSTS = new Set(['api.openai.com']);
const OPENROUTER_DEFAULT_HOSTS = new Set(['openrouter.ai']);

export interface OpenAIDetectOptions {
  customHosts?: readonly string[];
}

const parseUrl = (input: RequestInfo | URL): URL | undefined => {
  try {
    if (typeof input === 'string') return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return undefined;
  }
};

const isPostMethod = (input: RequestInfo | URL, init: RequestInit | undefined): boolean => {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return method === 'POST';
};

const isChatCompletionsPath = (pathname: string): boolean =>
  pathname === '/v1/chat/completions' || pathname === '/api/v1/chat/completions';

export const detectOpenAIChat = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: OpenAIDetectOptions = {},
): boolean => {
  if (!isPostMethod(input, init)) return false;
  const url = parseUrl(input);
  if (!url || !isChatCompletionsPath(url.pathname)) return false;
  const hosts = opts.customHosts
    ? new Set([...OPENAI_DEFAULT_HOSTS, ...opts.customHosts])
    : OPENAI_DEFAULT_HOSTS;
  return hosts.has(url.host);
};

export const detectOpenRouter = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: OpenAIDetectOptions = {},
): boolean => {
  if (!isPostMethod(input, init)) return false;
  const url = parseUrl(input);
  if (!url || !isChatCompletionsPath(url.pathname)) return false;
  const hosts = opts.customHosts
    ? new Set([...OPENROUTER_DEFAULT_HOSTS, ...opts.customHosts])
    : OPENROUTER_DEFAULT_HOSTS;
  return hosts.has(url.host);
};
