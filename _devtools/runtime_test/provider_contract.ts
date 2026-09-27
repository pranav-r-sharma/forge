// Reusable contract that ANY LlmProvider must satisfy (src/llm/provider.ts). Run against the real Ollama client (test_v15_provider.ts) and,
// later, against the OpenAI-compatible / MLX client — same assertions, different fake server. Not a test file itself (name doesn't start with "test").
import type { LlmProvider } from '../../src/llm/provider';

export interface ContractOptions {
  /** A model name the fake server treats as normal. */
  model: string;
  /** How to make the fake server return a slow stream (model name and/or message content). */
  slow: { model?: string; content?: string };
  /** How to make the fake server return an HTTP 500 for chat. */
  failing: { model?: string; content?: string };
  /** A model name for which embeddings fail (only used when the provider supports embeddings). */
  noEmbedModel?: string;
}

export async function runProviderContract(p: LlmProvider, label: string, ok: (c: any, m: string) => void, o: ContractOptions): Promise<void> {
  const c = p.capabilities;
  ok(!!c && typeof c.id === 'string' && typeof c.label === 'string', `[${label}] declares capabilities with an id and label`);
  ok(['none', 'memory', 'memory+disk', 'unknown'].includes(c.promptCache) && ['per-request', 'server'].includes(c.contextWindow), `[${label}] capability enums are valid`);

  const h = await p.health();
  ok(h.ok === true, `[${label}] health() ok when the server is up`);

  const models = await p.listModels();
  ok(Array.isArray(models) && models.length >= 1 && typeof models[0].name === 'string', `[${label}] listModels() returns named models`);

  const ps = await p.ps();
  ok(Array.isArray(ps), `[${label}] ps() returns an array`);

  const streamed: string[] = [];
  let metrics: any;
  const text = await p.chat({ model: o.model, messages: [{ role: 'user', content: 'hi' }], temperature: 0, onToken: (t) => streamed.push(t), onMetrics: (m) => (metrics = m) });
  ok(text === 'Hello world' && streamed.join('') === 'Hello world', `[${label}] chat() streams tokens and resolves with the full text (got ${JSON.stringify(text)})`);
  ok(!!metrics && metrics.promptTokens === 42 && typeof metrics.evalTokens === 'number' && metrics.tokensPerSecond > 0, `[${label}] chat() reports token metrics (got ${JSON.stringify(metrics)})`);
  if (c.reportsTimings) ok(typeof metrics.promptEvalDurationMs === 'number' && metrics.promptEvalDurationMs > 0, `[${label}] reports prompt-eval timing when it advertises reportsTimings`);

  const gen = await p.generate({ model: o.model, prompt: 'x', suffix: 'y' });
  ok(gen === 'foobar' || gen === 'Hello world' || gen.length > 0, `[${label}] generate() returns text`);

  const emb = await p.embed(o.model, 'hello');
  if (c.embeddings) {
    ok(Array.isArray(emb) && emb.length === 3, `[${label}] embed() returns a vector`);
    let embThrew = false;
    let badEmb: any = 'unset';
    try { badEmb = await p.embed(o.noEmbedModel || 'no-embed', 'hello'); } catch { embThrew = true; }
    ok(!embThrew && badEmb === undefined, `[${label}] embed() failure resolves undefined and never throws`);
  } else {
    ok(emb === undefined, `[${label}] a provider without embeddings resolves embed() to undefined (and says so in capabilities)`);
  }

  let errMsg = '';
  try { await p.chat({ model: o.failing.model ?? o.model, messages: [{ role: 'user', content: o.failing.content ?? 'x' }] }); } catch (e: any) { errMsg = String(e?.message || e); }
  ok(/500|exploded|failed/i.test(errMsg), `[${label}] a server error surfaces as a thrown error with a useful message (got ${JSON.stringify(errMsg)})`);

  const ac = new AbortController();
  const seen: string[] = [];
  const t0 = Date.now();
  const pending = p.chat({ model: o.slow.model ?? o.model, messages: [{ role: 'user', content: o.slow.content ?? 'x' }], signal: ac.signal, onToken: (t) => { seen.push(t); if (seen.length === 3) ac.abort(); } });
  let aborted = false;
  try { await pending; } catch (e: any) { aborted = e?.name === 'AbortError'; }
  ok(aborted && Date.now() - t0 < 2500, `[${label}] abort mid-stream rejects with AbortError promptly, not after the whole slow stream (${Date.now() - t0} ms)`);
}
