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
  /** Nanoseconds. Only present on the final (done: true) chunk. */
  eval_duration?: number;
  prompt_eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

export interface GenerateStreamChunk {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  eval_count?: number;
  prompt_eval_count?: number;
  eval_duration?: number;
  prompt_eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

/** Perf/HW metrics derived from a completed chat()/generate() call — see item "HW Utilization metrics". */
export interface OllamaCallMetrics {
  model: string;
  promptTokens?: number;
  evalTokens?: number;
  /** Tokens/sec during generation (eval phase only — excludes prompt processing). */
  tokensPerSecond?: number;
  totalDurationMs?: number;
  loadDurationMs?: number;
}

export interface EmbeddingResponse {
  embedding: number[];
}

/** One entry from GET /api/ps — a currently loaded (resident) model. */
export interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  size_vram?: number;
  expires_at?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}

export interface OllamaPsResponse {
  models: OllamaPsModel[];
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
  /** Context window size to request from Ollama (options.num_ctx). Omitted = server default. */
  numCtx?: number;
  /** Minutes to keep the model resident after this call, or -1 for indefinitely, 0 to unload immediately. Omitted = server default (~5 min). */
  keepAliveMinutes?: number;
  /** Called once with perf metrics parsed from the final stream chunk, if the server reported them. */
  onMetrics?: (metrics: OllamaCallMetrics) => void;
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
  numCtx?: number;
  keepAliveMinutes?: number;
  onMetrics?: (metrics: OllamaCallMetrics) => void;
}
