// ============================================================================
// 0.15.0 (P0-9): LlmProvider abstraction. OllamaClient must implement it with NO behavior change; the shared contract runs against a fake Ollama server.
// ============================================================================
import { OllamaClient } from '../../src/ollama/client';
import { OLLAMA_CAPABILITIES, LlmProvider } from '../../src/llm/provider';
import { startFakeOllama } from './fixtures/fakeOllama';
import { runProviderContract } from './provider_contract';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

async function main() {
  const fake = await startFakeOllama();
  try {
    const client = new OllamaClient(() => fake.url);
    const asProvider: LlmProvider = client; // compile-time proof the class satisfies the interface
    ok(asProvider.capabilities === OLLAMA_CAPABILITIES && client.capabilities.id === 'ollama', 'OllamaClient exposes the Ollama capability set');
    ok(client.capabilities.contextWindow === 'per-request' && client.capabilities.keepAlive && client.capabilities.listsLoadedModels && client.capabilities.fim && client.capabilities.embeddings, 'Ollama capabilities describe per-request context, keep-alive, loaded-model listing, FIM and embeddings');
    await runProviderContract(client, 'ollama', ok, { model: 'm1', slowModel: 'slow-model', failingModel: 'boom', noEmbedModel: 'no-embed' });

    // Wire-level checks: existing request shape is unchanged (options carried through exactly as before).
    fake.requests.length = 0;
    await client.chat({ model: 'm1', messages: [{ role: 'user', content: 'x' }], temperature: 0.3, numCtx: 8192, keepAliveMinutes: -1, maxTokens: 64, stop: ['END'], format: 'json' });
    const body = fake.requests.find((r) => r.path === '/api/chat')!.body;
    ok(body.options.num_ctx === 8192 && body.options.num_predict === 64 && body.options.temperature === 0.3 && body.options.stop[0] === 'END' && body.keep_alive === -1 && body.format === 'json' && body.stream === true, `request shape unchanged: num_ctx/num_predict/temperature/stop/keep_alive/format/stream (got ${JSON.stringify(body)})`);
  } finally {
    await fake.close();
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 provider tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 provider tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_provider.ts:', err); process.exit(1); });
