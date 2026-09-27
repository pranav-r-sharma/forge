// LIVE check of MlxServerManager against the real mlx_lm.server + Ornith (dev tool). Verifies start/ready/chat/adopt/crash-detect/recover/stop and that no process is orphaned.
// usage: node _devtools/run-ts.js _devtools/bench/mlx_live_manager.ts <snapshot-dir> <out.json> [port]
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { MlxServerManager } from '../../src/llm/mlxServer';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';
import { readMemorySample } from '../../src/util/hwSampler';

const snapshot = process.argv[2], outFile = process.argv[3], port = Number(process.argv[4] || 8125);
const repo = path.resolve(__dirname, '..', '..');
const checks: any[] = [];
const rec = (name: string, pass: boolean, detail?: any) => { checks.push({ name, pass, detail }); console.log(pass ? 'ok -' : 'NOT OK -', name, detail !== undefined ? JSON.stringify(detail) : ''); };
const serverProcs = () => { try { return execFileSync('pgrep', ['-f', `mlx_lm.server.*--port ${port}`]).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const logs: string[] = [];
  const mgr = new MlxServerManager({ log: (l) => logs.push(l), availableGB: async () => (await readMemorySample())?.availableGB });
  const cfg = { pythonPath: path.join(repo, '_devtools/mlx-venv/bin/python'), model: snapshot, port, promptCacheBytes: 2 * 1024 ** 3, startupTimeoutMs: 180_000 };
  const client = new OpenAiCompatClient({ getBaseUrl: () => `http://127.0.0.1:${port}`, kind: 'mlx', getResident: async () => mgr.resident() });
  try {
    rec('nothing running before', serverProcs().length === 0);
    const t0 = Date.now();
    await mgr.ensure(cfg);
    rec('ensure() starts the real server and reaches ready', mgr.state === 'ready', { secs: (Date.now() - t0) / 1000 });
    rec('exactly one server process', serverProcs().length === 1, serverProcs());
    rec('resident() reports the loaded model with its real size', mgr.resident().length === 1 && mgr.resident()[0].size > 4e9, mgr.resident());
    rec('the server was started with the prompt-cache cap and loopback host', logs.some((l) => l.includes('--prompt-cache-bytes 2147483648') && l.includes('--host 127.0.0.1')));
    const reply = await client.chat({ model: 'x', messages: [{ role: 'user', content: 'Reply with exactly the single word: pong' }], thinking: false, maxTokens: 16, temperature: 0 });
    rec('a chat works through the managed server', /pong/i.test(reply), { reply });
    const ps = await client.ps();
    rec('provider.ps() shows the managed model', ps.length === 1);

    // a second manager (e.g. another VS Code window) ADOPTS instead of spawning a duplicate, and never kills it
    const other = new MlxServerManager({ log: () => {} });
    await other.ensure(cfg);
    rec('a second manager adopts the running server (no duplicate process)', other.state === 'ready' && serverProcs().length === 1);
    await other.stop();
    rec('stopping the adopting manager does not kill the server it does not own', serverProcs().length === 1 && (await client.health()).ok);

    // hard crash: SIGKILL the real child
    const pid = Number(serverProcs()[0]);
    process.kill(pid, 'SIGKILL');
    await sleep(1500);
    rec('a hard kill (SIGKILL) is detected as a crash', mgr.state === 'crashed', { state: mgr.state, err: mgr.lastError });
    rec('the crashed process is gone', serverProcs().length === 0);
    const t1 = Date.now();
    await mgr.ensure(cfg);
    rec('ensure() recovers with a fresh server after the crash', mgr.state === 'ready' && serverProcs().length === 1, { secs: (Date.now() - t1) / 1000 });
    const reply2 = await client.chat({ model: 'x', messages: [{ role: 'user', content: 'Reply with exactly the single word: ok' }], thinking: false, maxTokens: 12, temperature: 0 });
    rec('and it serves requests again', /ok/i.test(reply2), { reply2 });

    await mgr.stop();
    await sleep(1000);
    rec('stop() leaves NO server process behind', serverProcs().length === 0 && mgr.state === 'stopped', { procs: serverProcs() });
    const dead = await client.health();
    rec('and the port is closed', dead.ok === false);
  } catch (e: any) {
    rec('unexpected error', false, String(e?.message || e));
  } finally {
    try { await mgr.stop(); } catch { /* ignore */ }
    fs.writeFileSync(outFile, JSON.stringify({ snapshot: path.basename(snapshot), port, checks, logTail: logs.slice(-15) }, null, 2));
    const bad = checks.filter((c) => !c.pass).length;
    console.log(`\n${checks.length - bad} passed, ${bad} failed.`);
    process.exit(bad ? 1 : 0);
  }
}
main();
