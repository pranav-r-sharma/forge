import type { ChatRequestOptions, GenerateRequestOptions, OllamaPsModel, OllamaTagInfo } from '../ollama/types';

/**
 * Runtime-neutral interface to a local model server (v0.15.0 plan, Phase 0 §0.1a). Every place Forge talks to a model — the agent loop,
 * sub-agents, compaction, plan-first / critique / best-of-N, inline edit, autocomplete, embeddings, the model picker, the hardware readout —
 * goes through this, so Ollama and MLX (via an OpenAI-compatible server) are interchangeable and features can degrade gracefully instead of
 * assuming Ollama.
 *
 * The request/response types are still the Ollama-shaped ones in ../ollama/types (they already describe what Forge needs: streaming chat with
 * abort + metrics, raw FIM completion, embeddings, model listing, loaded-model listing). A provider ignores options it does not support and
 * says so in `capabilities`, which callers check instead of guessing.
 */
export type ProviderId = 'ollama' | 'mlx' | 'openai-compatible';

export interface ProviderCapabilities {
  id: ProviderId;
  label: string;
  /** Sends and parses the runtime's native `tools` / `tool_calls` (vs Forge's text protocol). */
  nativeTools: boolean;
  /** Honors `ChatRequestOptions.format` (JSON-schema constrained output). */
  structuredOutput: boolean;
  /** Supports raw fill-in-middle completion with a `suffix` (Tab autocomplete). */
  fim: boolean;
  /** Can produce embeddings (for @codebase search / chat-history search). */
  embeddings: boolean;
  /** Can switch a model's "thinking" mode on/off per request. */
  thinkingControl: boolean;
  /** Reuses the prompt-prefix cache across requests: 'memory' = within a running server, 'disk' = can persist/restore it. */
  promptCache: 'none' | 'memory' | 'memory+disk' | 'unknown';
  /** Reports exact prompt/generated token counts (vs Forge estimating from characters). */
  exactTokenUsage: boolean;
  /** Reports prompt-evaluation (prefill) timing, needed for prefill tok/s and cache-hit estimates. */
  reportsTimings: boolean;
  /** 'per-request' = the caller picks the context size each call (Ollama's num_ctx); 'server' = fixed when the server/model is started (MLX). */
  contextWindow: 'per-request' | 'server';
  /** Can list which models are currently resident in memory. */
  listsLoadedModels: boolean;
  /** Honors keep-alive (how long a model stays loaded after a request). */
  keepAlive: boolean;
}

export interface LlmProvider {
  readonly capabilities: ProviderCapabilities;
  /** Quick reachability check for the status bar and first-run diagnostics. Never throws. */
  health(): Promise<{ ok: boolean; error?: string }>;
  /** Models the server can serve (installed / available). */
  listModels(): Promise<OllamaTagInfo[]>;
  /** Models currently resident in memory. Best-effort: [] when unsupported or unreachable. */
  ps(): Promise<OllamaPsModel[]>;
  /** One embedding vector, or undefined if embeddings are unavailable/failed. Never throws. */
  embed(model: string, input: string): Promise<number[] | undefined>;
  /** Streaming chat; resolves with the full assistant text. Aborts via `signal`. */
  chat(opts: ChatRequestOptions): Promise<string>;
  /** Raw (non-chat) completion, used for fill-in-middle autocomplete. */
  generate(opts: GenerateRequestOptions): Promise<string>;
}

export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
  id: 'ollama',
  label: 'Ollama',
  nativeTools: false, // Forge does not yet send Ollama's `tools` field (plan §6.2); capability describes Forge's current use
  structuredOutput: true,
  fim: true,
  embeddings: true,
  thinkingControl: false,
  promptCache: 'memory',
  exactTokenUsage: true,
  reportsTimings: true,
  contextWindow: 'per-request',
  listsLoadedModels: true,
  keepAlive: true,
};
