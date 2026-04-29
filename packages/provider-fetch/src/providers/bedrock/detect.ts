// Bedrock Converse API URL pattern:
//   https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/converse
//   https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/converse-stream
//
// We deliberately don't try to detect /invoke or /invoke-with-response-stream
// here — those use per-model wire formats and need their own dispatcher.

const BEDROCK_HOST_RE = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

const isConversePath = (pathname: string): boolean =>
  pathname.endsWith('/converse') || pathname.endsWith('/converse-stream');

export interface BedrockDetectOptions {
  customHosts?: readonly string[];
}

export const detectBedrock = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: BedrockDetectOptions = {},
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

  if (!isConversePath(url.pathname)) return false;
  if (BEDROCK_HOST_RE.test(url.host)) return true;
  if (opts.customHosts && opts.customHosts.includes(url.host)) return true;
  return false;
};

/**
 * Pulls the model id out of a Bedrock Converse URL.
 * Path is `/model/<modelId>/converse[-stream]`. The model id is opaque and
 * may include slashes (e.g. `arn:aws:bedrock:...`), so we slice between
 * `/model/` and `/converse`.
 */
export const extractBedrockModel = (pathname: string): string | undefined => {
  const m = pathname.match(/\/model\/(.+?)\/converse(?:-stream)?$/);
  if (!m) return undefined;
  // Bedrock URL-encodes special chars (`:` `/`) inside the model id.
  try {
    return decodeURIComponent(m[1] ?? '');
  } catch {
    return m[1];
  }
};

export const isBedrockStreamPath = (pathname: string): boolean =>
  pathname.endsWith('/converse-stream');
