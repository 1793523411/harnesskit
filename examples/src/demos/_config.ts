// Shared config for all demos. Reads from .env (or process.env directly).
// Each demo asks for the providers it needs via `requireProvider(name)`.
// Missing → friendly error pointing at .env.example.

import type { FetchInterceptorOptions } from '@harnesskit/provider-fetch';

const need = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    console.error(
      `\n[config] missing env var: ${key}\n         copy examples/.env.example to examples/.env and fill in.\n`,
    );
    process.exit(1);
  }
  return v;
};

const opt = (key: string, fallback: string): string => process.env[key] ?? fallback;

export const PROVIDERS = {
  volcengine: () => ({
    apiKey: need('VOLCENGINE_API_KEY'),
    baseUrl: opt('VOLCENGINE_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3'),
    host: opt('VOLCENGINE_HOST', 'ark.cn-beijing.volces.com'),
    reasoning: opt('VOLCENGINE_REASONING_MODEL', 'ep-m-20260227190842-nrldn'),
    code: opt('VOLCENGINE_CODE_MODEL', 'ep-m-20260227191724-kpnmp'),
    mini: opt('VOLCENGINE_MINI_MODEL', 'doubao-seed-2-0-mini-260215'),
    fast: opt('VOLCENGINE_FAST_MODEL', 'deepseek-v3-2-251201'),
    apiKind: 'openai-completions' as const,
  }),
  deepseek: () => ({
    apiKey: need('DEEPSEEK_API_KEY'),
    baseUrl: opt('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
    host: opt('DEEPSEEK_HOST', 'api.deepseek.com'),
    reasoning: opt('DEEPSEEK_REASONING_MODEL', 'deepseek-reasoner'),
    chat: opt('DEEPSEEK_CHAT_MODEL', 'deepseek-chat'),
    apiKind: 'openai-completions' as const,
  }),
  poloGemini: () => ({
    apiKey: need('POLO_GEMINI_API_KEY'),
    baseUrl: opt('POLO_GEMINI_BASE_URL', 'https://poloai.top/v1'),
    host: opt('POLO_GEMINI_HOST', 'poloai.top'),
    thinking: opt('POLO_GEMINI_THINKING_MODEL', 'gemini-3-flash-preview-thinking'),
    fast: opt('POLO_GEMINI_FAST_MODEL', 'gemini-3-flash-preview'),
    apiKind: 'openai-completions' as const,
  }),
  poloGpt: () => ({
    apiKey: need('POLO_GPT_API_KEY'),
    baseUrl: opt('POLO_GPT_BASE_URL', 'https://poloai.top/v1'),
    host: opt('POLO_GPT_HOST', 'poloai.top'),
    full: opt('POLO_GPT_MODEL', 'gpt-5'),
    mini: opt('POLO_GPT_MINI', 'gpt-5-mini'),
    apiKind: 'openai-completions' as const,
  }),
  poloClaude: () => ({
    apiKey: need('POLO_CLAUDE_API_KEY'),
    baseUrl: opt('POLO_CLAUDE_BASE_URL', 'https://poloai.top'),
    host: opt('POLO_CLAUDE_HOST', 'poloai.top'),
    thinking: opt('POLO_CLAUDE_THINKING_MODEL', 'claude-sonnet-4-6-thinking'),
    fast: opt('POLO_CLAUDE_FAST_MODEL', 'claude-sonnet-4-20250514'),
    apiKind: 'anthropic-messages' as const,
  }),
  minimax: () => ({
    apiKey: need('MINIMAX_API_KEY'),
    baseUrl: opt('MINIMAX_BASE_URL', 'https://api.minimaxi.com/anthropic'),
    host: opt('MINIMAX_HOST', 'api.minimaxi.com'),
    fast: opt('MINIMAX_FAST_MODEL', 'MiniMax-M2.7-highspeed'),
    apiKind: 'anthropic-messages' as const,
  }),
  openai: () => ({
    apiKey: need('OPENAI_API_KEY'),
    baseUrl: opt('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    host: opt('OPENAI_HOST', 'api.openai.com'),
    nano: opt('OPENAI_NANO_MODEL', 'gpt-5.4-nano'),
    mini: opt('OPENAI_MINI_MODEL', 'gpt-5.4-mini'),
    apiKind: 'openai-completions' as const,
  }),
};

/** Union of all custom hosts our demos might hit. */
export const ALL_CUSTOM_HOSTS: NonNullable<FetchInterceptorOptions['customHosts']> = {
  openai: ['ark.cn-beijing.volces.com', 'api.deepseek.com', 'poloai.top'],
  anthropic: ['poloai.top', 'api.minimaxi.com'],
};
