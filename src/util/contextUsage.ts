import { OllamaCallMetrics } from '../ollama/types';

/**
 * Tokens the last model call occupied in the context window (full prompt + reply), for the context meter.
 * `promptTokens` alone is only the part the runtime EVALUATED — cached prefix tokens are left out — so with a warm prompt cache it
 * reads a few hundred tokens while the real prompt is many thousands. Prefer the full prompt size: promptTotalTokens, else
 * evaluated + cached, else the agent loop's chars/token estimate (Ollama reports neither), never below the evaluated count.
 */
export function contextUsedTokens(m: OllamaCallMetrics | undefined): number | undefined {
  if (!m) return undefined;
  const evaluated = m.promptTokens;
  const prompt =
    m.promptTotalTokens ??
    (evaluated !== undefined && m.cachedTokens !== undefined ? evaluated + m.cachedTokens : undefined) ??
    (m.estPromptTokens !== undefined ? Math.max(m.estPromptTokens, evaluated ?? 0) : evaluated);
  if (prompt === undefined && m.evalTokens === undefined) return undefined;
  return (prompt ?? 0) + (m.evalTokens ?? 0);
}
