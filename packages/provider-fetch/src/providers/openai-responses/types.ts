export interface InputTextPart {
  type: 'input_text';
  text: string;
}
export interface OutputTextPart {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
}
export type ResponsesContentPart =
  | InputTextPart
  | OutputTextPart
  | { type: string; [k: string]: unknown };

export interface ResponsesMessageItem {
  type: 'message';
  id?: string;
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | ResponsesContentPart[];
}

export interface ResponsesFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  id?: string;
  call_id: string;
  output: string;
}

export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: { type: string; text: string }[];
}

export type ResponsesItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem
  | { type: string; [k: string]: unknown };

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  max_output_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export interface ResponsesResponse {
  id: string;
  object?: string;
  model: string;
  status?: string;
  output: ResponsesItem[];
  usage?: ResponsesUsage;
}
