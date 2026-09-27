import { ChatRequestOptions, GenerateRequestOptions, OllamaPsModel, OllamaTagInfo } from '../ollama/types';
import { OllamaClient } from '../ollama/client';
import { OpenAiCompatClient } from './openaiCompatClient';
import { LlmProvider, ProviderCapabilities, ProviderId, parseProviderId } from './provider';

export { parseProviderId };

/** The slice of ForgeConfig the provider layer needs (kept narrow so it can be tested without vscode). */
export interface ProviderConfig {
  provider: ProviderId;
  ollamaBaseUrl: string;
  mlxBaseUrl: string;
  openaiCompatBaseUrl: string;
}

/** What the active provider is and where it lives — for status text and error messages, so they never say "Ollama" when it is MLX. */
export function providerEndpoint(cfg: ProviderConfig): { id: ProviderId; label: string; baseUrl: string } {
  const id = parseProviderId(cfg.provider);
  if (id === 'mlx') return { id, label: 'MLX (mlx_lm.server)', baseUrl: cfg.mlxBaseUrl };
  if (id === 'openai-compatible') return { id, label: 'OpenAI-compatible server', baseUrl: cfg.openaiCompatBaseUrl };
  return { id, label: 'Ollama', baseUrl: cfg.ollamaBaseUrl };
}

export interface SwitchableProviderDeps {
  /** What is resident in the MLX server, for ps() — supplied by the MLX lifecycle manager (P0-12). */
  getResident?: () => Promise<OllamaPsModel[]>;
  /** Makes sure the managed MLX server is running for the current settings (starts/restarts it). Awaited before chat/model-listing on MLX; rejects with a user-readable error. */
  ensureReady?: () => Promise<void>;
  /** Current state of the managed MLX server, so health() can say "starting" instead of blocking or failing. */
  mlxState?: () => 'stopped' | 'starting' | 'ready' | 'crashed' | 'stopping';
  mlxLastError?: () => string | undefined;
}

/**
 * The provider Forge actually holds: it reads the CURRENT settings on every call and delegates to the right client, so switching
 * `forge.provider` or a base URL takes effect immediately with no reload. Clients are cached per (provider, url).
 *
 * Per-role routing (v0.15.0 §0.1a): chat/agent/summaries/model-listing go to the active provider; **embeddings and Tab-autocomplete
 * (FIM) fall back to Ollama when the active provider cannot do them** (mlx_lm.server has neither), so `@codebase` semantic search and
 * autocomplete keep working while chat runs on MLX. If Ollama isn't running those degrade exactly as they already do (keyword search / no
 * completion) — never an exception.
 */
export class SwitchableProvider implements LlmProvider {
  private cache = new Map<string, LlmProvider>();

  constructor(private readonly getCfg: () => ProviderConfig, private readonly deps: SwitchableProviderDeps = {}) {}

  private build(id: ProviderId, baseUrl: string): LlmProvider {
    const key = `${id}|${baseUrl}`;
    let p = this.cache.get(key);
    if (!p) {
      p =
        id === 'ollama'
          ? new OllamaClient(() => this.getCfg().ollamaBaseUrl)
          : new OpenAiCompatClient({
              kind: id,
              getBaseUrl: () => (id === 'mlx' ? this.getCfg().mlxBaseUrl : this.getCfg().openaiCompatBaseUrl),
              getResident: id === 'mlx' ? this.deps.getResident : undefined,
            });
      this.cache.set(key, p);
    }
    return p;
  }

  /** The provider selected in settings right now. */
  active(): LlmProvider {
    const e = providerEndpoint(this.getCfg());
    return this.build(e.id, e.baseUrl);
  }

  private ollama(): LlmProvider {
    return this.build('ollama', this.getCfg().ollamaBaseUrl);
  }

  get capabilities(): ProviderCapabilities {
    return this.active().capabilities;
  }
  /** Before using the MLX runtime, make sure its (managed) server is up. A no-op for other runtimes or when nothing is managed. */
  private async prepare(): Promise<void> {
    if (providerEndpoint(this.getCfg()).id === 'mlx') await this.deps.ensureReady?.();
  }
  async health(): Promise<{ ok: boolean; error?: string }> {
    if (providerEndpoint(this.getCfg()).id === 'mlx' && this.deps.ensureReady) {
      // Never block a status-bar poll on a 30+ s model load: kick the start in the background and report what is happening.
      const state = this.deps.mlxState?.();
      if (state === 'starting') return { ok: false, error: 'the MLX server is starting (loading the model)…' };
      if (state !== 'ready') {
        void this.deps.ensureReady().catch(() => undefined);
        if (state === 'crashed' || state === 'stopped' || state === undefined) {
          const h = await this.active().health();
          if (h.ok) return h;
          return { ok: false, error: this.deps.mlxLastError?.() || h.error || 'the MLX server is not running' };
        }
      }
    }
    return this.active().health();
  }
  async listModels(): Promise<OllamaTagInfo[]> {
    await this.prepare();
    return this.active().listModels();
  }
  ps(): Promise<OllamaPsModel[]> {
    return this.active().ps();
  }
  async chat(opts: ChatRequestOptions): Promise<string> {
    await this.prepare();
    return this.active().chat(opts);
  }
  embed(model: string, input: string): Promise<number[] | undefined> {
    const a = this.active();
    return (a.capabilities.embeddings ? a : this.ollama()).embed(model, input);
  }
  generate(opts: GenerateRequestOptions): Promise<string> {
    const a = this.active();
    return (a.capabilities.fim ? a : this.ollama()).generate(opts);
  }
}
