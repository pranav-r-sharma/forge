import { ChatRequestOptions, GenerateRequestOptions, OllamaCallMetrics, OllamaPsModel, OllamaTagInfo } from '../ollama/types';
import { OllamaError } from '../ollama/client';
import { LlmProvider, MLX_CAPABILITIES, OPENAI_COMPAT_CAPABILITIES, ProviderCapabilities } from './provider';
import { logger } from '../util/logger';

/**
 * Incremental Server-Sent-Events parser (WHATWG "text/event-stream"), pure and dependency-free. Feed it decoded text in whatever chunking the
 * network produced; it returns the complete `data:` payloads. Handles \r\n / \n / \r, a "\r" split from its "\n" across chunks, ":" comment /
 * keep-alive lines, multi-line data, ignorable fields (`event:`, `id:`, `retry:`), and frames split at any byte boundary.
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];

  push(chunk: string): string[] {
    const lines = (this.buf + chunk).split(/\r\n|\n|\r(?!$)/);
    this.buf = lines.pop() ?? '';
    return this.consume(lines);
  }

  /** Call when the stream ends: processes a final unterminated line and dispatches any pending event. */
  end(): string[] {
    const out = this.consume(this.buf ? [this.buf.replace(/\r$/, ''), ''] : ['']);
    this.buf = '';
    return out;
  }

  private consume(lines: string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith(':')) {
        /* comment / keep-alive */
      } else {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}

export interface OpenAiCompatOptions {
  getBaseUrl: () => string;
  /** 'mlx' = mlx_lm.server semantics (always addresses the one loaded model as "default_model", no embeddings/FIM); anything else = generic server. */
  kind?: 'mlx' | 'openai-compatible';
  getApiKey?: () => string | undefined;
  /** Reports what is currently loaded (the lifecycle manager knows; the server API doesn't say). Used by ps(). */
  getResident?: () => Promise<OllamaPsModel[]>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * LlmProvider for any OpenAI-compatible server — in particular `mlx_lm.server` (v0.15.0 Phase 0, MLX-first). Zero dependencies (Node fetch).
 *
 * mlx_lm.server facts this is written against (read from the installed 0.31.3 source, not assumed): POST /v1/chat/completions and /v1/completions,
 * GET /v1/models (lists the MLX models in the local Hugging Face cache) and /health; NO embeddings endpoint; usage arrives in a final chunk when
 * `stream_options.include_usage` is set and includes `prompt_tokens_details.cached_tokens`; thinking text arrives separately as `delta.reasoning`;
 * requests for a model name other than the server's own trigger a model LOAD, so Forge always sends "default_model" (the server's loaded model).
 */
export class OpenAiCompatClient implements LlmProvider {
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.capabilities = opts.kind === 'openai-compatible' ? OPENAI_COMPAT_CAPABILITIES : MLX_CAPABILITIES;
  }

  private url(path: string): string {
    return `${this.opts.getBaseUrl().replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.opts.getApiKey?.();
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  private modelName(requested: string): string {
    return this.capabilities.id === 'mlx' ? 'default_model' : requested;
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    for (const path of ['/health', '/v1/models']) {
      try {
        const res = await fetch(this.url(path), { headers: this.headers(), signal: AbortSignal.timeout(3000) });
        if (res.ok) return { ok: true };
        if (res.status !== 404) return { ok: false, error: `HTTP ${res.status}` };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    }
    return { ok: false, error: 'HTTP 404' };
  }

  async listModels(): Promise<OllamaTagInfo[]> {
    const res = await fetch(this.url('/v1/models'), { headers: this.headers() });
    if (!res.ok) throw new OllamaError(`Failed to list models (HTTP ${res.status})`);
    const data = (await res.json()) as { data?: { id?: string; created?: number }[] };
    return (data.data || [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({ name: m.id as string, model: m.id as string, size: 0, digest: '' }));
  }

  async ps(): Promise<OllamaPsModel[]> {
    try {
      return (await this.opts.getResident?.()) ?? [];
    } catch {
      return [];
    }
  }

  async embed(model: string, input: string): Promise<number[] | undefined> {
    if (!this.capabilities.embeddings) return undefined; // mlx_lm.server has no embeddings endpoint
    try {
      const res = await fetch(this.url('/v1/embeddings'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ model: this.modelName(model), input }) });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { data?: { embedding?: number[] }[] };
      return data.data?.[0]?.embedding;
    } catch (err) {
      logger.warn('embed() failed', String(err));
      return undefined;
    }
  }

  async chat(opts: ChatRequestOptions): Promise<string> {
    const body: Record<string, any> = {
      model: this.modelName(opts.model),
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) })),
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.2,
    };
    if (opts.maxTokens !== undefined && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
    else if (opts.maxTokens === 0) logger.warn('OpenAI-compat chat: maxTokens is 0 — omitting output cap (runtime may use a low default)');
    if (opts.stop && opts.stop.length) body.stop = opts.stop;
    if (opts.thinking !== undefined && this.capabilities.thinkingControl) body.chat_template_kwargs = { enable_thinking: opts.thinking };
    // numCtx / keepAliveMinutes / format have no equivalent here: the context window is fixed when the server starts, models stay loaded.

    const t0 = performance.now();
    const res = await this.post('/v1/chat/completions', body, opts.signal);
    let full = '';
    let firstTokenAt: number | undefined;
    let usage: any;
    let finishReason: string | undefined;
    await this.readSse(res, (json) => {
      if (json.error) throw new OllamaError(`Chat request failed: ${typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error)}`);
      if (json.usage) usage = json.usage;
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
      const delta = json.choices?.[0]?.delta;
      if (!delta) return;
      const content: unknown = delta.content;
      const reasoning: unknown = delta.reasoning ?? delta.reasoning_content;
      if ((typeof content === 'string' && content) || (typeof reasoning === 'string' && reasoning)) firstTokenAt ??= performance.now();
      if (typeof content === 'string' && content) {
        full += content;
        opts.onToken?.(content);
      }
    });
    opts.onMetrics?.({ ...this.metrics(opts.model, t0, firstTokenAt, performance.now(), usage), finishReason });
    return full;
  }

  async generate(opts: GenerateRequestOptions): Promise<string> {
    const body: Record<string, any> = { model: this.modelName(opts.model), prompt: opts.prompt, stream: true, temperature: opts.temperature ?? 0.1 };
    if (opts.maxTokens !== undefined && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
    else if (opts.maxTokens === 0) logger.warn('OpenAI-compat chat: maxTokens is 0 — omitting output cap (runtime may use a low default)');
    if (opts.stop && opts.stop.length) body.stop = opts.stop;
    // `suffix` (fill-in-middle) is not part of mlx_lm.server's /v1/completions — capabilities.fim is false, callers should not rely on it.
    const t0 = performance.now();
    const res = await this.post('/v1/completions', body, opts.signal);
    let full = '';
    let firstTokenAt: number | undefined;
    let usage: any;
    await this.readSse(res, (json) => {
      if (json.error) throw new OllamaError(`Completion request failed: ${typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error)}`);
      if (json.usage) usage = json.usage;
      const text: unknown = json.choices?.[0]?.text;
      if (typeof text === 'string' && text) {
        firstTokenAt ??= performance.now();
        full += text;
      }
    });
    opts.onMetrics?.(this.metrics(opts.model, t0, firstTokenAt, performance.now(), usage));
    return full;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err; // a user Stop, not an unreachable server
      throw new OllamaError(`Could not reach the ${this.capabilities.label} at ${this.opts.getBaseUrl()}. Is it running?`, err);
    }
    if (!res.ok || !res.body) {
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      throw new OllamaError(`${this.capabilities.label} request failed (HTTP ${res.status}): ${text}`);
    }
    return res;
  }

  private async readSse(res: Response, onJson: (json: any) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    const handle = (payloads: string[]) => {
      for (const p of payloads) {
        if (p.trim() === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(p);
        } catch {
          logger.warn('Failed to parse SSE payload', p.slice(0, 200));
          continue;
        }
        onJson(json);
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      handle(parser.push(decoder.decode(value, { stream: true })));
    }
    handle(parser.push(decoder.decode()));
    handle(parser.end());
  }

  /**
   * Metrics from usage + client-side timing. `promptTokens` keeps the Ollama meaning (tokens EVALUATED = prompt − cached) so the trace and
   * the UI mean the same thing on every runtime. Prefill time is approximated by time-to-first-token (flagged `timingsApproximate`).
   */
  private metrics(model: string, t0: number, firstTokenAt: number | undefined, t1: number, usage: any): OllamaCallMetrics {
    const total = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
    const cachedRaw = usage?.prompt_tokens_details?.cached_tokens;
    const cached = typeof cachedRaw === 'number' && cachedRaw >= 0 ? cachedRaw : undefined;
    const completion = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined;
    const ttft = firstTokenAt === undefined ? undefined : firstTokenAt - t0;
    const genMs = firstTokenAt === undefined ? undefined : t1 - firstTokenAt;
    return {
      model,
      promptTokens: total === undefined ? undefined : Math.max(0, total - (cached ?? 0)),
      promptTotalTokens: total,
      cachedTokens: cached,
      evalTokens: completion,
      // the first token is produced at the end of prefill, so generation speed is measured over the remaining tokens
      tokensPerSecond: completion !== undefined && completion > 1 && genMs !== undefined && genMs > 0 ? round1(((completion - 1) / genMs) * 1000) : undefined,
      totalDurationMs: Math.round(t1 - t0),
      promptEvalDurationMs: ttft === undefined ? undefined : Math.round(ttft),
      evalDurationMs: genMs === undefined ? undefined : Math.round(genMs),
      timingsApproximate: true,
    };
  }
}
