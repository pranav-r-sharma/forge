// Reusable contract that ANY LlmProvider must satisfy (src/llm/provider.ts). Run against the real Ollama client (test_v15_provider.ts) and,
// later, against the OpenAI-compatible / MLX client — same assertions, different fake server. Not a test file itself (name doesn't start with "test").
import type { LlmProvider } from '../../src/llm/provider';

export interface ContractOptions {
  /** A model name the fake server treats as normal. */
  model: string;
  /** A model name whose stream is slow enough to abort mid-way. */
  slowModel: string;
  /** A model name that makes the server return an HTTP error for chat. */
  failingModel: string;
  /** A model name for which embeddings fail. */
  noEmbedModel: string;
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
  ok(Array.isArray(emb) && emb.length === 3, `[${label}] embed() returns a vector`);
  let embThrew = false;
  let badEmb: any = 'unset';
  try { badEmb = await p.embed(o.noEmbedModel, 'hello'); } catch { embThrew = true; }
  ok(!embThrew && badEmb === undefined, `[${label}] embed() failure resolves undefined and never throws`);

  let errMsg = '';
  try { await p.chat({ model: o.failingModel, messages: [{ role: 'user', content: 'x' }] }); } catch (e: any) { errMsg = String(e?.message || e); }
  ok(/500|exploded|failed/i.test(errMsg), `[${label}] a server error surfaces as a thrown error with a useful message (got ${JSON.stringify(errMsg)})`);

  const ac = new AbortController();
  const seen: string[] = [];
  const t0 = Date.now();
  const pending = p.chat({ model: o.slowModel, messages: [{ role: 'user', content: 'x' }], signal: ac.signal, onToken: (t) => { seen.push(t); if (seen.length === 3) ac.abort(); } });
  let aborted = false;
  try { await pending; } catch (e: any) { aborted = e?.name === 'AbortError'; }
  ok(aborted && Date.now() - t0 < 2500, `[${label}] abort mid-stream rejects with AbortError promptly, not after the whole slow stream (${Date.now() - t0} ms)`);
}
