const DEFAULT_HOSTS = new Set(['api.anthropic.com']);

export interface AnthropicDetectOptions {
  /** Additional hosts to treat as Anthropic-compatible (e.g. proxies). */
  customHosts?: readonly string[];
}

const isVertexAnthropicHost = (host: string): boolean =>
  /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(host);

const isVertexAnthropicPath = (pathname: string): boolean =>
  /\/publishers\/anthropic\/models\/[^:]+:(rawPredict|streamRawPredict)$/.test(pathname);

const isMessagesPath = (pathname: string): boolean => pathname.endsWith('/v1/messages');

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

  // Vertex AI hosts Anthropic Claude under :rawPredict / :streamRawPredict.
  // The path-detect is sufficient since the regex requires "/publishers/anthropic/".
  if (isVertexAnthropicHost(url.host) && isVertexAnthropicPath(url.pathname)) return true;

  if (!isMessagesPath(url.pathname)) return false;
  const hosts = opts.customHosts ? new Set([...DEFAULT_HOSTS, ...opts.customHosts]) : DEFAULT_HOSTS;
  return hosts.has(url.host);
};

/**
 * Vertex Claude URLs end with `:streamRawPredict` for streaming. We use this
 * to override the request's `stream` field if the body doesn't have one.
 */
export const isVertexAnthropicStreamPath = (pathname: string): boolean =>
  pathname.endsWith(':streamRawPredict');

/**
 * Extracts the model id from a Vertex Anthropic path. Vertex Claude doesn't
 * carry `model` in the request body — model lives in the URL path.
 */
export const extractVertexAnthropicModel = (pathname: string): string | undefined => {
  const m = pathname.match(/\/publishers\/anthropic\/models\/([^:]+):/);
  return m ? m[1] : undefined;
};
