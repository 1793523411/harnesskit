export interface GeminiTextPart {
  text: string;
  /** True for chain-of-thought parts on Gemini 2.5+ reasoning models. */
  thought?: boolean;
}

export interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}

export interface GeminiFunctionCallPart {
  functionCall: { id?: string; name: string; args?: unknown };
}

export interface GeminiFunctionResponsePart {
  functionResponse: { id?: string; name: string; response: unknown };
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | { [k: string]: unknown };

export interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent | { parts: GeminiPart[] };
  tools?: GeminiTool[];
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    thinkingConfig?: { includeThoughts?: boolean; thinkingBudget?: number };
  };
  /** Internal — model id extracted from URL path. */
  _harnessModel?: string;
  /** Internal — `:streamGenerateContent` vs `:generateContent`. */
  _harnessStream?: boolean;
  [k: string]: unknown;
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
}
