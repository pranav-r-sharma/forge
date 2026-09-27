// Which request SHAPES hit mlx_lm.server's prompt cache on a hybrid model (Ornith)? Live, against a real server. Dev tool.
// usage: node _devtools/run-ts.js _devtools/bench/mlx_cache_patterns.ts <snapshot-dir> <out.json> [port]
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';
import { ChatMessage } from '../../src/ollama/types';

const snapshot = process.argv[2], outFile = process.argv[3], port = Number(process.argv[4] || 8124);
const repo = path.resolve(__dirname, '..', '..');
const rows: any[] = [];
const lorem = (chars: number, seed: number) => { let s = ''; let i = 0; while (s.length < chars) { i++; s += `def h${seed}_${(i * 7919) % 99991}(req, ctx):\n    return {'id': ${(i * 104729) % 99991}, 'ok': ctx.get('k${i}', ${i % 13}) > ${i % 7}}\n`; } return s; };

async function main() {
  const server: ChildProcess = spawn(path.join(repo, '_devtools/mlx-venv/bin/python'), ['-m', 'mlx_lm.server', '--model', snapshot, '--host', '127.0.0.1', '--port', String(port), '--log-level', 'WARNING'], { env: { ...process.env, HF_HUB_OFFLINE: '1' }, stdio: 'ignore' });
  const client = new OpenAiCompatClient({ getBaseUrl: () => `http://127.0.0.1:${port}`, kind: 'mlx' });
  const run = async (label: string, messages: ChatMessage[], thinking = false) => {
    let m: any; let text = '';
    const t = Date.now();
    text = await client.chat({ model: 'x', messages, thinking, maxTokens: 8, temperature: 0, onMetrics: (mm) => (m = mm) });
    const row = { label, total: m.promptTotalTokens, cached: m.cachedTokens, evaluated: m.promptTokens, ttftMs: m.promptEvalDurationMs, wallMs: Date.now() - t, hitPct: m.promptTotalTokens ? Math.round(100 * (m.cachedTokens ?? 0) / m.promptTotalTokens) : 0 };
    rows.push(row); console.log(JSON.stringify(row)); return text;
  };
  try {
    for (let i = 0; i < 120; i++) { if ((await client.health()).ok) break; await new Promise((r) => setTimeout(r, 1000)); }
    const sys: ChatMessage = { role: 'system', content: 'You are a terse coding assistant.' };
    const big = lorem(9000, 1);
    // A. baseline: exact repeat of an identical request
    const A: ChatMessage[] = [sys, { role: 'user', content: big + '\nName one function.' }];
    await run('A1 cold (sys + one big user msg)', A);
    await run('A2 EXACT repeat of A1', A);
    // B. big shared content in its OWN message, question in a later message (agent-like: context message, then ask)
    const ctx: ChatMessage[] = [sys, { role: 'user', content: lorem(9000, 2) }, { role: 'assistant', content: 'Understood.' }];
    await run('B1 cold [sys, U(big), A(ok), U(q1)]', [...ctx, { role: 'user', content: 'Name one function.' }]);
    await run('B2 same prefix, DIFFERENT last user msg', [...ctx, { role: 'user', content: 'How many functions are there?' }]);
    await run('B3 same prefix, third question', [...ctx, { role: 'user', content: 'Which is the last function?' }]);
    // C. true append-only agent loop: each request = previous messages + the model's real reply + a new user (tool result) message
    let hist: ChatMessage[] = [sys, { role: 'user', content: lorem(9000, 3) + '\nTask: inspect.' }];
    for (let step = 1; step <= 4; step++) {
      const reply = await run(`C${step} append-only step ${step} (msgs=${hist.length})`, hist);
      hist = [...hist, { role: 'assistant', content: reply }, { role: 'user', content: `[Tool result ${step}] ${lorem(600, 10 + step)}` }];
    }
    // D. same as C but the assistant text is NOT what the model returned (a re-rendered/edited assistant message)
    let h2: ChatMessage[] = [sys, { role: 'user', content: lorem(9000, 4) + '\nTask: inspect.' }];
    await run('D1 cold', h2);
    h2 = [...h2, { role: 'assistant', content: 'a slightly different assistant message than generated' }, { role: 'user', content: 'next' }];
    await run('D2 assistant message differs from what was generated', h2);
    // E. an OLD message in the middle is rewritten (what Forge's stale-read pruning does)
    const e1: ChatMessage[] = [sys, { role: 'user', content: 'task' }, { role: 'assistant', content: 'read a' }, { role: 'user', content: lorem(9000, 5) }, { role: 'assistant', content: 'read b' }, { role: 'user', content: lorem(2000, 6) }];
    await run('E1 cold: [sys,U,A,U(big file),A,U(file2)]', e1);
    const e2 = e1.map((m, i) => (i === 3 ? { ...m, content: '[superseded]' } : m)).concat([{ role: 'assistant', content: 'x' }, { role: 'user', content: 'more' }]);
    await run('E2 the big OLD tool result replaced by a stub (context pruning)', e2 as ChatMessage[]);
  } catch (e: any) {
    console.log('ERROR', e?.message || e);
  } finally {
    server.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); if (server.exitCode === null) server.kill('SIGKILL');
    fs.writeFileSync(outFile, JSON.stringify({ snapshot: path.basename(snapshot), rows }, null, 2));
  }
}
main();
