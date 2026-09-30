import type { ForgeConfig } from './config';

/** User-facing send-path toast when provider health() fails before a turn starts. */
export function formatForgeHealthErrorToast(cfg: ForgeConfig, detail: string): string {
  const err = detail.trim() || 'unknown error';
  switch (cfg.provider) {
    case 'mlx':
      return `Can't reach the MLX server at ${cfg.mlxBaseUrl} — Forge starts it automatically when forge.mlx.autoStart is on; check the MLX model path (${err}).`;
    case 'openai-compatible':
      return `Can't reach the OpenAI-compatible API at ${cfg.openaiCompatBaseUrl} (${err}).`;
    default:
      return `Can't reach Ollama (${err}). Run "ollama serve" and try again.`;
  }
}
