import {
  ChatMessage,
  ChatRequestOptions,
  ChatStreamChunk,
  EmbeddingResponse,
  GenerateRequestOptions,
  GenerateStreamChunk,
  OllamaCallMetrics,
  OllamaPsResponse,
  OllamaTagInfo,
  OllamaTagsResponse,
} from './types';
import { logger } from '../util/logger';

/** `0` in ForgeConfig.keepAliveMinutes means "server default" — translate that to "omit the field" for the wire request. -1 (never unload) and positive minute counts pass through as-is. */
export function keepAliveOpt(minutes: number): number | undefined {
  return minutes === 0 ? undefined : minutes;
}

export class OllamaError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OllamaError';
  }
}

/**
 * Minimal, dependency-free client for a local Ollama server. Uses Node 18+'s
 * global `fetch` so the extension ships with zero runtime npm dependencies.
 */
export class OllamaClient {
  constructor(private getBaseUrl: () => string) {}

  private url(path: string): string {
    return `${this.getBaseUrl()}${path}`;
  }

  /** Quick reachability check used for the status bar and first-run diagnostics. */
  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(this.url('/api/tags'), { method: 'GET' });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async listModels(): Promise<OllamaTagInfo[]> {
    const res = await fetch(this.url('/api/tags'));
    if (!res.ok) throw new OllamaError(`Failed to list models (HTTP ${res.status})`);
    const data = (await res.json()) as OllamaTagsResponse;
    return data.models || [];
  }

  /**
   * Currently resident (loaded-in-memory) models, per GET /api/ps — used for
   * the HW utilization readout (VRAM per model, time until auto-unload).
   * Best-effort: returns an empty list rather than throwing if the server is
   * unreachable or the endpoint isn't supported by an older Ollama version.
   */
  async ps(): Promise<OllamaPsResponse['models']> {
    try {
      const res = await fetch(this.url('/api/ps'));
      if (!res.ok) return [];
      const data = (await res.json()) as OllamaPsResponse;
      return data.models || [];
    } catch {
      return [];
    }
  }

  async embed(model: string, input: string): Promise<number[] | undefined> {
    try {
      const res = await fetch(this.url('/api/embeddings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: input }),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as EmbeddingResponse;
      return data.embedding;
    } catch (err) {
      logger.warn('embed() failed', String(err));
      return undefined;
    }
  }

  /** Streaming chat completion. Resolves with the full assistant text once the stream ends. */
  async chat(opts: ChatRequestOptions): Promise<string> {
    const body: Record<string, any> = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      ...(opts.keepAliveMinutes !== undefined ? { keep_alive: opts.keepAliveMinutes === -1 ? -1 : `${opts.keepAliveMinutes}m` } : {}),
      ...(opts.format ? { format: opts.format } : {}),
      options: {
        temperature: opts.temperature ?? 0.2,
        ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        ...(opts.stop ? { stop: opts.stop } : {}),
      },
    };

    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err: any) {
      // A user-initiated Stop aborts the in-flight fetch, which surfaces here
      // as a plain AbortError — that's not "Ollama is unreachable", it's the
      // user clicking Stop, and callers need to be able to tell the two
      // apart (see agentLoop.ts) instead of showing a misleading "Could not
      // reach Ollama" toast for something the user did on purpose.
      if (err?.name === 'AbortError') throw err;
      throw new OllamaError(
        `Could not reach Ollama at ${this.getBaseUrl()}. Is it running? (ollama serve)`,
        err
      );
    }

    if (!res.ok || !res.body) {
      const text = await safeText(res);
      throw new OllamaError(`Ollama chat request failed (HTTP ${res.status}): ${text}`);
    }

    let full = '';
    await readNdjson<ChatStreamChunk>(res.body, (chunk) => {
      const token = chunk.message?.content ?? '';
      if (token) {
        full += token;
        opts.onToken?.(token);
      }
      if (chunk.done) opts.onMetrics?.(metricsFromChunk(opts.model, chunk));
    });
    return full;
  }

  /** Non-chat completion endpoint, used for fill-in-middle (FIM) autocomplete. */
  async generate(opts: GenerateRequestOptions): Promise<string> {
    const body: Record<string, any> = {
      model: opts.model,
      prompt: opts.prompt,
      stream: true,
      ...(opts.keepAliveMinutes !== undefined ? { keep_alive: opts.keepAliveMinutes === -1 ? -1 : `${opts.keepAliveMinutes}m` } : {}),
      options: {
        temperature: opts.temperature ?? 0.1,
        ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        ...(opts.stop ? { stop: opts.stop } : {}),
      },
    };
    if (opts.suffix !== undefined) body.suffix = opts.suffix;
    if (opts.raw) body.raw = true;

    let res: Response;
    try {
      res = await fetch(this.url('/api/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      throw new OllamaError(`Could not reach Ollama at ${this.getBaseUrl()}.`, err);
    }

    if (!res.ok || !res.body) {
      const text = await safeText(res);
      throw new OllamaError(`Ollama generate request failed (HTTP ${res.status}): ${text}`);
    }

    let full = '';
    await readNdjson<GenerateStreamChunk>(res.body, (chunk) => {
      if (chunk.response) full += chunk.response;
      if (chunk.done) opts.onMetrics?.(metricsFromChunk(opts.model, chunk));
    });
    return full;
  }
}

function metricsFromChunk(model: string, chunk: ChatStreamChunk | GenerateStreamChunk): OllamaCallMetrics {
  const evalTokens = chunk.eval_count;
  const evalDurationMs = chunk.eval_duration !== undefined ? chunk.eval_duration / 1e6 : undefined;
  const tokensPerSecond =
    evalTokens && evalDurationMs && evalDurationMs > 0 ? Math.round((evalTokens / evalDurationMs) * 1000 * 10) / 10 : undefined;
  return {
    model,
    promptTokens: chunk.prompt_eval_count,
    evalTokens,
    tokensPerSecond,
    totalDurationMs: chunk.total_duration !== undefined ? Math.round(chunk.total_duration / 1e6) : undefined,
    loadDurationMs: chunk.load_duration !== undefined ? Math.round(chunk.load_duration / 1e6) : undefined,
    promptEvalDurationMs: chunk.prompt_eval_duration !== undefined ? Math.round(chunk.prompt_eval_duration / 1e6) : undefined,
    evalDurationMs: chunk.eval_duration !== undefined ? Math.round(chunk.eval_duration / 1e6) : undefined,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Reads a newline-delimited JSON stream (Ollama's wire format) and invokes `onChunk` per object. */
async function readNdjson<T>(body: ReadableStream<Uint8Array>, onChunk: (chunk: T) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        onChunk(JSON.parse(line) as T);
      } catch (err) {
        logger.warn('Failed to parse Ollama stream line', line);
      }
    }
  }
  const rest = buffer.trim();
  if (rest) {
    try {
      onChunk(JSON.parse(rest) as T);
    } catch {
      /* trailing partial line, ignore */
    }
  }
}

export function pickBestDefaultModel(models: OllamaTagInfo[]): string | undefined {
  if (models.length === 0) return undefined;
  const preferenceOrder = [
    /qwen2\.5-coder/i,
    /qwen2-coder/i,
    /deepseek-coder-v2/i,
    /deepseek-coder/i,
    /codestral/i,
    /codegemma/i,
    /starcoder2/i,
    /codellama/i,
    /llama3\.1/i,
    /llama3/i,
    /mistral/i,
  ];
  for (const pattern of preferenceOrder) {
    const match = models.find((m) => pattern.test(m.name));
    if (match) return match.name;
  }
  return models[0].name;
}

export function pickBestCompletionModel(models: OllamaTagInfo[]): string | undefined {
  if (models.length === 0) return undefined;
  // Prefer small, fast coder models for low-latency inline completion.
  const preferenceOrder = [
    /qwen2\.5-coder:1\.5b/i,
    /qwen2\.5-coder:3b/i,
    /qwen2\.5-coder:7b/i,
    /qwen2\.5-coder/i,
    /deepseek-coder:1\.3b/i,
    /deepseek-coder:6\.7b/i,
    /deepseek-coder/i,
    /starcoder2:3b/i,
    /starcoder2/i,
    /codegemma:2b/i,
    /codegemma/i,
    /codellama:7b-code/i,
    /codellama/i,
  ];
  for (const pattern of preferenceOrder) {
    const match = models.find((m) => pattern.test(m.name));
    if (match) return match.name;
  }
  return models[0].name;
}
