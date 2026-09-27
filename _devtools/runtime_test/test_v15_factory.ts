// ============================================================================
// 0.15.0 (P0-11): provider selection. SwitchableProvider reads settings on every call; embeddings/FIM fall back to Ollama when the active
// runtime can't do them; getConfig() derives the effective context window per runtime; unknown settings degrade to Ollama.
// ============================================================================
import * as vscode from 'vscode';
import { SwitchableProvider, providerEndpoint, ProviderConfig } from '../../src/llm/factory';
import { parseProviderId } from '../../src/llm/provider';
import { getConfig } from '../../src/util/config';
import { startFakeOllama } from './fixtures/fakeOllama';
import { startFakeOpenAI } from './fixtures/fakeOpenAI';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const vs: any = vscode;

async function testMlxReadyHooks() {
  const ox = await startFakeOpenAI();
  try {
    const cfg: ProviderConfig = { provider: 'mlx', ollamaBaseUrl: 'http://127.0.0.1:1', mlxBaseUrl: ox.url, openaiCompatBaseUrl: ox.url };
    const order: string[] = [];
    let state: any = 'stopped';
    let err: string | undefined;
    let fail = false;
    const p = new SwitchableProvider(() => cfg, {
      ensureReady: async () => { order.push('ensure'); if (fail) throw new Error('MLX model missing'); state = 'ready'; },
      mlxState: () => state, mlxLastError: () => err,
    });
    await p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    ok(order[0] === 'ensure' && ox.requests.some((r) => r.path === '/v1/chat/completions'), 'chat on MLX first awaits ensureReady(), then talks to the server');
    order.length = 0; await p.listModels();
    ok(order[0] === 'ensure', 'listModels() also ensures the server is up');
    fail = true;
    let msg = ''; try { await p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }); } catch (e: any) { msg = e.message; }
    ok(/MLX model missing/.test(msg), 'an ensureReady() failure surfaces as the chat error (a user-readable reason, not a connection error)');
    fail = false;
    state = 'starting'; order.length = 0;
    const h = await p.health();
    ok(!h.ok && /starting/.test(h.error || '') && order.length === 0, 'health() while the server is loading reports "starting" immediately — it never blocks a status-bar poll on a long model load');
    state = 'crashed'; err = 'The MLX server exited unexpectedly (code 1).';
    const dead = new SwitchableProvider(() => ({ ...cfg, mlxBaseUrl: 'http://127.0.0.1:1' }), { ensureReady: async () => {}, mlxState: () => state, mlxLastError: () => err });
    const h2 = await dead.health();
    ok(!h2.ok && /exited unexpectedly/.test(h2.error || ''), 'health() after a crash reports the manager\'s own error message');
    cfg.provider = 'ollama'; order.length = 0;
    await new SwitchableProvider(() => ({ ...cfg, ollamaBaseUrl: 'http://127.0.0.1:1' }), { ensureReady: async () => { order.push('ensure'); } }).health();
    ok(order.length === 0, 'on Ollama, ensureReady() is never called');
  } finally {
    await ox.close();
  }
}

async function main() {
  const ol = await startFakeOllama();
  const ox = await startFakeOpenAI();
  try {
    const cfg: ProviderConfig = { provider: 'ollama', ollamaBaseUrl: ol.url, mlxBaseUrl: ox.url, openaiCompatBaseUrl: ox.url };
    const p = new SwitchableProvider(() => cfg);

    ok(parseProviderId('mlx') === 'mlx' && parseProviderId('openai-compatible') === 'openai-compatible' && parseProviderId('ollama') === 'ollama', 'valid provider ids parse');
    ok(parseProviderId(undefined) === 'ollama' && parseProviderId('gpt5') === 'ollama' && parseProviderId(42) === 'ollama' && parseProviderId('') === 'ollama', 'unknown / garbled values fall back to Ollama, never throw');
    ok(providerEndpoint(cfg).label === 'Ollama' && providerEndpoint({ ...cfg, provider: 'mlx' }).label.startsWith('MLX') && providerEndpoint({ ...cfg, provider: 'mlx' }).baseUrl === ox.url, 'providerEndpoint names the active runtime and its URL (for status text / errors)');

    // ---- Ollama active ----
    ok(p.capabilities.id === 'ollama', 'capabilities follow the active provider (ollama)');
    ol.requests.length = 0; ox.requests.length = 0;
    const t1 = await p.chat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    ok(t1 === 'Hello world' && ol.requests.some((r) => r.path === '/api/chat') && ox.requests.length === 0, 'chat goes to Ollama, not the OpenAI-style server');

    // ---- switch to MLX with NO reload ----
    cfg.provider = 'mlx';
    ok(p.capabilities.id === 'mlx', 'capabilities switch immediately when the setting changes');
    ol.requests.length = 0; ox.requests.length = 0;
    const t2 = await p.chat({ model: 'whatever', messages: [{ role: 'user', content: 'hi' }] });
    ok(t2 === 'Hello world' && ox.requests.some((r) => r.path === '/v1/chat/completions') && !ol.requests.some((r) => r.path === '/api/chat'), 'after switching to mlx, chat goes to the MLX server');
    ok((await p.health()).ok && ox.requests.some((r) => r.path === '/health'), 'health() checks the ACTIVE server');
    ok((await p.listModels())[0].name.includes('Ornith'), 'listModels() comes from the active server');

    // ---- per-role fallback: embeddings + FIM stay on Ollama while chat is on MLX ----
    ol.requests.length = 0; ox.requests.length = 0;
    const emb = await p.embed('nomic-embed-text', 'hello');
    ok(Array.isArray(emb) && emb.length === 3 && ol.requests.some((r) => r.path === '/api/embeddings') && !ox.requests.some((r) => r.path === '/v1/embeddings'), 'embeddings fall back to Ollama when MLX can\'t provide them (so @codebase semantic search keeps working)');
    const gen = await p.generate({ model: 'm1', prompt: 'x', suffix: 'y' });
    ok(gen.length > 0 && ol.requests.some((r) => r.path === '/api/generate'), 'FIM autocomplete falls back to Ollama (MLX has no suffix support)');

    // ---- generic OpenAI-compatible ----
    cfg.provider = 'openai-compatible';
    ok(p.capabilities.id === 'openai-compatible', 'switching to a generic server works too');
    ox.requests.length = 0;
    await p.chat({ model: 'my-model', messages: [{ role: 'user', content: 'hi' }] });
    ok(ox.requests[0].body.model === 'my-model', 'a generic server receives the requested model name (MLX would receive "default_model")');

    // ---- URL change creates a fresh client, no stale connection ----
    cfg.provider = 'mlx';
    const second = await startFakeOpenAI();
    cfg.mlxBaseUrl = second.url;
    ox.requests.length = 0; second.requests.length = 0;
    await p.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    ok(second.requests.length > 0 && ox.requests.length === 0, 'changing the MLX base URL takes effect on the next call');
    await second.close();

    // ---- Ollama down while MLX active: embeddings degrade, chat unaffected ----
    const down: ProviderConfig = { provider: 'mlx', ollamaBaseUrl: 'http://127.0.0.1:1', mlxBaseUrl: ox.url, openaiCompatBaseUrl: ox.url };
    const p2 = new SwitchableProvider(() => down);
    ok((await p2.embed('m', 'x')) === undefined, 'with Ollama unreachable, embeddings resolve undefined (keyword-search fallback) and never throw');
    ok((await p2.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })) === 'Hello world', 'and chat on MLX is unaffected');

    // ---- getConfig(): provider + effective context window ----
    vs.__resetConfig();
    ok(getConfig().provider === 'ollama' && getConfig().numCtx === 32768, 'defaults: provider ollama, numCtx 32768');
    vs.__setConfig({ 'forge.numCtx': 8192 });
    ok(getConfig().numCtx === 8192, 'Ollama: forge.numCtx is used');
    vs.__setConfig({ 'forge.provider': 'mlx', 'forge.mlx.contextTokens': 65536 });
    ok(getConfig().provider === 'mlx' && getConfig().numCtx === 65536, 'MLX: the effective context window is forge.mlx.contextTokens (forge.numCtx is a per-request Ollama knob and is ignored)');
    ok(getConfig().mlxBaseUrl === 'http://127.0.0.1:8123' && getConfig().openaiCompatBaseUrl === 'http://127.0.0.1:1234', 'default MLX / OpenAI-compatible URLs are localhost-only');
    vs.__setConfig({ 'forge.provider': 'nonsense' });
    ok(getConfig().provider === 'ollama' && getConfig().numCtx === 8192, 'a garbled provider setting degrades to Ollama (and its numCtx)');
    vs.__setConfig({ 'forge.mlx.baseUrl': 'http://127.0.0.1:9000///' });
    ok(getConfig().mlxBaseUrl === 'http://127.0.0.1:9000', 'trailing slashes are trimmed from base URLs');
    vs.__resetConfig();
  } finally {
    await ol.close();
    await ox.close();
  }
  await testMlxReadyHooks();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 provider-selection tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 provider-selection tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_factory.ts:', err); process.exit(1); });
