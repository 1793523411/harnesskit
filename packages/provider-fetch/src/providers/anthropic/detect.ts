const DEFAULT_HOSTS = new Set(['api.anthropic.com']);

export interface AnthropicDetectOptions {
  /** Additional hosts to treat as Anthropic-compatible (e.g. proxies). */
  customHosts?: readonly string[];
}

export const detectAnthropic = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: AnthropicDetectOptions = {},
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

  if (url.pathname !== '/v1/messages') return false;
  const hosts = opts.customHosts ? new Set([...DEFAULT_HOSTS, ...opts.customHosts]) : DEFAULT_HOSTS;
  return hosts.has(url.host);
};
