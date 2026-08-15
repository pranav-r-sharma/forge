/** Shared types for talking to a local Ollama server (https://github.com/ollama/ollama/blob/main/docs/api.md). */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Populated when this message is the result of a tool call, for models with native tool support. */
  name?: string;
}

export interface OllamaTagInfo {
  name: string;
  model: string;
  size: number;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
  modified_at?: string;
}

export interface OllamaTagsResponse {
  models: OllamaTagInfo[];
}

export interface ChatStreamChunk {
  model: string;
  created_at: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface GenerateStreamChunk {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
}

export interface EmbeddingResponse {
  embedding: number[];
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  /** Optional: cap output length via num_predict. */
  maxTokens?: number;
  /** Extra stop sequences appended to the model request. */
  stop?: string[];
}

export interface GenerateRequestOptions {
  model: string;
  prompt: string;
  suffix?: string;
  temperature?: number;
  signal?: AbortSignal;
  maxTokens?: number;
  stop?: string[];
  raw?: boolean;
}
