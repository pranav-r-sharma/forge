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
  health() {
    return this.active().health();
  }
  listModels(): Promise<OllamaTagInfo[]> {
    return this.active().listModels();
  }
  ps(): Promise<OllamaPsModel[]> {
    return this.active().ps();
  }
  chat(opts: ChatRequestOptions): Promise<string> {
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
