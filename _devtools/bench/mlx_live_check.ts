// LIVE check of OpenAiCompatClient against a REAL mlx_lm.server running Ornith (dev tool, not a unit test; needs the MLX venv + cached snapshot).
// usage: node _devtools/run-ts.js _devtools/bench/mlx_live_check.ts <snapshot-dir> <out.json> [port]
// Memory-safe: one 4-bit/8-bit model, offline (HF_HUB_OFFLINE=1), trust_remote_code off, localhost only, killed at the end.
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';

const snapshot = process.argv[2];
const outFile = process.argv[3];
const port = Number(process.argv[4] || 8123);
const repo = path.resolve(__dirname, '..', '..');
const results: any = { snapshot: path.basename(snapshot), port, checks: [] };
const rec = (name: string, pass: boolean, detail?: any) => { results.checks.push({ name, pass, detail }); console.log(pass ? 'ok -' : 'NOT OK -', name, detail !== undefined ? JSON.stringify(detail) : ''); };

function lorem(chars: number): string {
  let s = ''; let i = 0;
  while (s.length < chars) { i++; s += `def handler_${i * 7919 % 99991}(req, ctx):\n    return {'id': ${i * 104729 % 99991}, 'ok': ctx.get('k${i}', ${i % 13}) > ${i % 7}}\n`; }
  return s;
}

async function main() {
  const server: ChildProcess = spawn(path.join(repo, '_devtools/mlx-venv/bin/python'), ['-m', 'mlx_lm.server', '--model', snapshot, '--host', '127.0.0.1', '--port', String(port), '--log-level', 'WARNING'], {
    env: { ...process.env, HF_HUB_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout?.on('data', (d) => (serverLog += d)); server.stderr?.on('data', (d) => (serverLog += d));
  const client = new OpenAiCompatClient({ getBaseUrl: () => `http://127.0.0.1:${port}`, kind: 'mlx' });
  const t0 = Date.now();
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { up = (await client.health()).ok; if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    rec('server becomes healthy', up, { secs: (Date.now() - t0) / 1000 });
    if (!up) throw new Error('server did not start: ' + serverLog.slice(-600));

    const models = await client.listModels();
    rec('listModels() returns the cached Ornith MLX repos', models.some((m) => /Ornith-1\.5-9B-MLX/.test(m.name)), models.map((m) => m.name).slice(0, 6));

    let m1: any;
    const reply = await client.chat({ model: 'x', messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }], thinking: false, maxTokens: 24, temperature: 0, onMetrics: (m) => (m1 = m) });
    rec('a real chat reply arrives, thinking off', /pong/i.test(reply), { reply: reply.slice(0, 60) });
    rec('real usage/metrics are populated', typeof m1?.promptTotalTokens === 'number' && typeof m1?.evalTokens === 'number' && m1.tokensPerSecond > 0, m1);

    // thinking ON: the reasoning must not leak into content
    let m2: any;
    const r2 = await client.chat({ model: 'x', messages: [{ role: 'user', content: 'What is 2+2? Answer briefly.' }], thinking: true, maxTokens: 400, temperature: 0, onMetrics: (m) => (m2 = m) });
    rec('with thinking on, the visible reply is separate from the reasoning', r2.length > 0 && !/<think>|<\/think>/.test(r2), { reply: r2.slice(0, 80), evalTokens: m2?.evalTokens });

    // PROMPT CACHE: same long prefix twice, different tail
    const prefix = lorem(9000); // ~3.5-4k tokens
    const ask = (tail: string) => new Promise<any>(async (resolve) => {
      let m: any; const t = Date.now();
      await client.chat({ model: 'x', messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: prefix + '\n\n' + tail }], thinking: false, maxTokens: 6, temperature: 0, onMetrics: (mm) => (m = mm) });
      resolve({ ...m, wallMs: Date.now() - t });
    });
    const c1 = await ask('Q1: name one function above.');
    const c2 = await ask('Q2: name a different function above.');
    const c3 = await ask('Q3: how many functions?');
    results.cache = { first: c1, second: c2, third: c3 };
    rec('cold request evaluates the whole prompt (little/no cache)', (c1.cachedTokens ?? 0) < 0.2 * c1.promptTotalTokens, { total: c1.promptTotalTokens, cached: c1.cachedTokens, ttftMs: c1.promptEvalDurationMs });
    rec('second request with the same prefix is served mostly from the prompt cache', (c2.cachedTokens ?? 0) > 0.7 * c2.promptTotalTokens, { total: c2.promptTotalTokens, cached: c2.cachedTokens, evaluated: c2.promptTokens, ttftMs: c2.promptEvalDurationMs });
    rec('…and its time-to-first-token drops sharply', c2.promptEvalDurationMs < 0.5 * c1.promptEvalDurationMs, { cold: c1.promptEvalDurationMs, warm: c2.promptEvalDurationMs });
    rec('third request also reuses the cache', (c3.cachedTokens ?? 0) > 0.7 * c3.promptTotalTokens, { cached: c3.cachedTokens, total: c3.promptTotalTokens });

    // ABORT mid-generation; server must survive
    const ac = new AbortController(); let aborted = false; const ta = Date.now();
    const p = client.chat({ model: 'x', messages: [{ role: 'user', content: 'Write a very long story about a lighthouse.' }], thinking: false, maxTokens: 400, signal: ac.signal, onToken: () => { if (Date.now() - ta > 1500) ac.abort(); } });
    try { await p; } catch (e: any) { aborted = e?.name === 'AbortError'; }
    rec('abort mid-generation rejects with AbortError', aborted, { ms: Date.now() - ta });
    await new Promise((r) => setTimeout(r, 1500));
    rec('server is still healthy after an aborted request', (await client.health()).ok);
    let m3: any;
    const after = await client.chat({ model: 'x', messages: [{ role: 'user', content: 'Reply with exactly the single word: ok' }], thinking: false, maxTokens: 12, temperature: 0, onMetrics: (m) => (m3 = m) });
    rec('a new request works after the abort', /ok/i.test(after), { reply: after.slice(0, 40) });
  } catch (e: any) {
    rec('unexpected error', false, String(e?.message || e));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    if (!server.killed || server.exitCode === null) server.kill('SIGKILL');
    results.serverLogTail = serverLog.slice(-400);
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
    const bad = results.checks.filter((c: any) => !c.pass).length;
    console.log(`\n${results.checks.length - bad} passed, ${bad} failed.`);
    process.exit(bad ? 1 : 0);
  }
}
main();
