// ============================================================================
// 0.15.0 (P0-10): OpenAI-compatible / MLX provider (src/llm/openaiCompatClient.ts).
//   - SseParser: pure, tested against every awkward framing a real network produces.
//   - The shared provider contract (same assertions Ollama passes), against a fake mlx_lm.server-style server.
//   - Wire format, metrics (cached tokens, TTFT), thinking control, failure modes.
// ============================================================================
import { OpenAiCompatClient, SseParser } from '../../src/llm/openaiCompatClient';
import { MLX_CAPABILITIES, OPENAI_COMPAT_CAPABILITIES } from '../../src/llm/provider';
import { OllamaError } from '../../src/ollama/client';
import { startFakeOpenAI } from './fixtures/fakeOpenAI';
import { runProviderContract } from './provider_contract';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

function testSse() {
  const p = new SseParser();
  ok(eq(p.push('data: {"a":1}\n\n'), ['{"a":1}']), 'a complete event is returned');
  ok(eq(p.push('data: one\n\ndata: two\n\n'), ['one', 'two']), 'several events in one chunk');
  const p2 = new SseParser();
  const whole = 'data: {"x":"héllo"}\n\n: keep-alive\n\ndata: second\n\n';
  const out: string[] = [];
  for (const ch of whole) out.push(...p2.push(ch)); // one character at a time — the worst case
  ok(eq(out, ['{"x":"héllo"}', 'second']), 'events survive being fed one character at a time');
  const p3 = new SseParser();
  ok(eq([...p3.push('data: a\r\n\r\ndata: b\r\n\r\n')], ['a', 'b']), 'CRLF line endings');
  const p4 = new SseParser();
  const o4 = [...p4.push('data: a\r'), ...p4.push('\n\r'), ...p4.push('\ndata: b\r\n\r\n')];
  ok(eq(o4, ['a', 'b']), 'a "\\r" split from its "\\n" across chunks is one line break, not two');
  const p5 = new SseParser();
  ok(eq(p5.push(': ping\n\n: pong\n\n'), []), 'comment / keep-alive lines produce nothing');
  ok(eq(new SseParser().push('data: line1\ndata: line2\n\n'), ['line1\nline2']), 'multi-line data is joined with newlines');
  ok(eq(new SseParser().push('event: message\nid: 7\nretry: 100\ndata: hi\n\n'), ['hi']), 'event/id/retry fields are ignored');
  ok(eq(new SseParser().push('data:nospace\n\n'), ['nospace']), 'a missing space after the colon is accepted');
  ok(eq(new SseParser().push('\n\n\n'), []), 'empty events produce nothing');
  const p6 = new SseParser();
  ok(eq(p6.push('data: last'), []) && eq(p6.end(), ['last']), 'end() flushes a final unterminated event');
  ok(eq(new SseParser().end(), []), 'end() on an empty parser is a no-op');
  ok(eq(new SseParser().push('data: [DONE]\n\n'), ['[DONE]']), '[DONE] is delivered as data (the client filters it)');
}

async function testContractAndWire() {
  const fake = await startFakeOpenAI();
  try {
    let key: string | undefined;
    const mlx = new OpenAiCompatClient({ getBaseUrl: () => fake.url, kind: 'mlx', getApiKey: () => key });
    ok(mlx.capabilities === MLX_CAPABILITIES && mlx.capabilities.id === 'mlx', 'kind "mlx" exposes MLX capabilities');
    ok(!mlx.capabilities.embeddings && !mlx.capabilities.fim && mlx.capabilities.thinkingControl && mlx.capabilities.contextWindow === 'server' && !mlx.capabilities.reportsTimings, 'MLX capabilities: no embeddings/FIM, thinking control, server-fixed context, approximate timings');

    await runProviderContract(mlx, 'mlx', ok, { model: 'ornith', slow: { content: 'SLOW' }, failing: { content: 'FAIL' } });

    // ---- wire format ----
    fake.requests.length = 0;
    await mlx.chat({ model: 'ornith-ai/Ornith-1.5-9B-MLX-4bit', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], temperature: 0.3, maxTokens: 64, stop: ['END'], numCtx: 99999, keepAliveMinutes: -1, format: 'json' });
    const b = fake.requests.find((r) => r.path === '/v1/chat/completions')!.body;
    ok(b.model === 'default_model', 'MLX always addresses the loaded model as "default_model" (a different name would make the server LOAD a model)');
    ok(b.stream === true && b.stream_options?.include_usage === true, 'streams with include_usage so cached-token counts come back');
    ok(b.temperature === 0.3 && b.max_tokens === 64 && eq(b.stop, ['END']), 'temperature / max_tokens / stop are sent');
    ok(!('num_ctx' in b) && !('options' in b) && !('keep_alive' in b) && !('format' in b) && !('chat_template_kwargs' in b), 'Ollama-only options (num_ctx, keep_alive, format) are NOT sent; no thinking override unless asked');
    ok(b.messages.length === 2 && b.messages[0].role === 'system' && b.messages[1].content === 'go', 'messages pass through in order');

    fake.requests.length = 0;
    await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'go' }], thinking: false });
    ok(eq(fake.requests[0].body.chat_template_kwargs, { enable_thinking: false }), 'thinking:false → chat_template_kwargs.enable_thinking=false');
    fake.requests.length = 0;
    await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'go' }], thinking: true });
    ok(eq(fake.requests[0].body.chat_template_kwargs, { enable_thinking: true }), 'thinking:true → enable_thinking=true');

    key = 'sekret';
    fake.requests.length = 0;
    await mlx.listModels();
    ok(fake.requests[0].headers.authorization === 'Bearer sekret', 'an API key, when configured, is sent as a Bearer token');
    key = undefined;

    // ---- streamed content, reasoning separation, metrics ----
    const toks: string[] = [];
    let m: any;
    const text = await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }], onToken: (t) => toks.push(t), onMetrics: (mm) => (m = mm) });
    ok(text === 'Hello world' && toks.join('') === 'Hello world', 'only content is returned/streamed — the thinking ("reasoning") text is kept out of the reply');
    ok(m.promptTotalTokens === 50 && m.cachedTokens === 8 && m.promptTokens === 42, `promptTokens = tokens EVALUATED (50 total − 8 cached = 42), matching Ollama's meaning (got ${JSON.stringify({ t: m.promptTotalTokens, c: m.cachedTokens, e: m.promptTokens })})`);
    ok(m.evalTokens === 3 && m.timingsApproximate === true, 'completion tokens reported; timings flagged approximate');
    ok(typeof m.promptEvalDurationMs === 'number' && m.promptEvalDurationMs >= 0 && m.promptEvalDurationMs < m.totalDurationMs, `prefill time is approximated by time-to-first-token — a thinking token counts as the first token, since prefill ends when generation starts (got ${m.promptEvalDurationMs} of ${m.totalDurationMs} ms)`);
    ok(m.tokensPerSecond > 0 && m.totalDurationMs >= m.promptEvalDurationMs, `generation speed is computed client-side over the tokens after the first (got ${m.tokensPerSecond} tok/s)`);

    // ---- resilience ----
    let mm2: any;
    const t2 = await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'MALFORMED' }], onMetrics: (x) => (mm2 = x) });
    ok(t2 === 'Hello world' && mm2.cachedTokens === 8, 'a garbage `data:` line mid-stream is skipped; the rest of the reply and the usage still arrive');
    let streamErr = '';
    try { await mlx.chat({ model: 'x', messages: [{ role: 'user', content: 'STREAMERR' }] }); } catch (e: any) { streamErr = e instanceof OllamaError ? e.message : 'wrong type: ' + e; }
    ok(/kaboom/.test(streamErr), `an error object delivered INSIDE the stream is thrown as OllamaError (got ${JSON.stringify(streamErr)})`);
    const g = await mlx.generate({ model: 'x', prompt: 'code', suffix: 'ignored', maxTokens: 8, stop: ['\n'] });
    const gb = fake.requests.filter((r) => r.path === '/v1/completions').pop()!.body;
    ok(g === 'foobar' && gb.max_tokens === 8 && eq(gb.stop, ['\n']) && !('suffix' in gb), 'generate() uses /v1/completions; the unsupported `suffix` is not sent');
    ok((await mlx.ps()).length === 0, 'ps() is empty when no resident-model reporter is supplied');
    const withResident = new OpenAiCompatClient({ getBaseUrl: () => fake.url, kind: 'mlx', getResident: async () => [{ name: 'ornith', model: 'ornith', size: 4_700_000_000 }] });
    ok((await withResident.ps())[0]?.name === 'ornith', 'ps() reports what the lifecycle manager says is resident');
    const throwingResident = new OpenAiCompatClient({ getBaseUrl: () => fake.url, kind: 'mlx', getResident: async () => { throw new Error('x'); } });
    ok((await throwingResident.ps()).length === 0, 'a failing resident-model reporter degrades to []');

    // ---- generic OpenAI-compatible flavour ----
    const generic = new OpenAiCompatClient({ getBaseUrl: () => fake.url, kind: 'openai-compatible' });
    ok(generic.capabilities === OPENAI_COMPAT_CAPABILITIES, 'kind "openai-compatible" exposes the conservative capability set');
    fake.requests.length = 0;
    await generic.chat({ model: 'my-model', messages: [{ role: 'user', content: 'hi' }], thinking: false });
    ok(fake.requests[0].body.model === 'my-model' && !('chat_template_kwargs' in fake.requests[0].body), 'a generic server gets the requested model name and no thinking override it can\'t honor');
  } finally {
    await fake.close();
  }
}

async function testUnreachable() {
  const dead = new OpenAiCompatClient({ getBaseUrl: () => 'http://127.0.0.1:1', kind: 'mlx' });
  const h = await dead.health();
  ok(h.ok === false && !!h.error, 'health() is false with a reason when the server is down');
  let msg = '';
  try { await dead.chat({ model: 'x', messages: [{ role: 'user', content: 'x' }] }); } catch (e: any) { msg = e instanceof OllamaError ? e.message : 'wrong type'; }
  ok(/Could not reach the MLX/.test(msg), `an unreachable server gives a clear error (got ${JSON.stringify(msg)})`);
  let listThrew = false;
  try { await dead.listModels(); } catch { listThrew = true; }
  ok(listThrew, 'listModels() rejects when the server is down (callers show "not running")');
  ok((await dead.embed('m', 'x')) === undefined, 'embed() never throws');
}

async function main() {
  testSse();
  await testContractAndWire();
  await testUnreachable();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 OpenAI-compatible client tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 OpenAI-compatible client tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_openai_client.ts:', err); process.exit(1); });
