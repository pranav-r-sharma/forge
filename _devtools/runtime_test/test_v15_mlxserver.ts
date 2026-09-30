// ============================================================================
// 0.15.0 (P0-12): MLX server lifecycle manager (src/llm/mlxServer.ts) — driven by a fake child process and fake health probe.
// Safety rules under test: offline only, loopback only, no remote code, adopt-don't-kill an external server, free-memory check before loading,
// SIGTERM→SIGKILL escalation, crash detection, restart on config change, serialized concurrent callers.
// ============================================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { MlxServerManager, MlxServerError, buildServerArgs, resolveModelPath, modelWeightsBytes, MlxServerConfig, ChildLike, makeEnsureMlx, resolvePython, parseLocalServerUrl } from '../../src/llm/mlxServer';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MLX_CFG = JSON.stringify({ quantization: { bits: 4 } });
function makeModelDir(bytes = 10): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mlx-model-'));
  fs.writeFileSync(path.join(d, 'config.json'), MLX_CFG);
  const f = path.join(d, 'model.safetensors');
  fs.writeFileSync(f, 'x');
  if (bytes > 1) fs.truncateSync(f, bytes);
  return d;
}

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter() as any;
  stderr = new EventEmitter() as any;
  pid = 4242;
  signals: string[] = [];
  ignoreTerm = false;
  exited = false;
  kill(sig: any = 'SIGTERM') {
    this.signals.push(String(sig));
    if (sig === 'SIGKILL' || !this.ignoreTerm) setImmediate(() => this.die(null, String(sig)));
    return true;
  }
  die(code: number | null, signal: string | null = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
}

interface Rig { mgr: MlxServerManager; children: FakeChild[]; spawns: { cmd: string; args: string[]; env: any }[]; logs: string[]; setHealthy: (b: boolean) => void; healthyAfterPolls: (n: number) => void; setAvail: (v: number | undefined) => void; }
// adoptProbeAttempts defaults to 1 here (not the real production default of 3) so every pre-existing test's healthyAfterPolls(n)
// keeps meaning exactly what it always did: n failures at the adopt-check, then success on the first startup-wait poll after
// spawning. Tests that specifically exercise the multi-try adopt probe pass adoptProbeAttempts explicitly.
function rig(opts: { adoptExternal?: boolean; adoptProbeAttempts?: number } = {}): Rig {
  let healthy = !!opts.adoptExternal;
  let polls = -1;
  let avail: number | undefined = undefined;
  const children: FakeChild[] = [];
  const spawns: Rig['spawns'] = [];
  const logs: string[] = [];
  const mgr = new MlxServerManager({
    spawn: (cmd, args, o) => { const c = new FakeChild(); children.push(c); spawns.push({ cmd, args, env: o.env }); return c; },
    isHealthy: async () => { if (polls >= 0) { polls--; if (polls < 0) healthy = true; } return healthy; },
    availableGB: async () => avail,
    log: (l) => logs.push(l), sleep: (ms) => sleep(Math.min(ms, 2)), killGraceMs: 60, pollMs: 2,
    adoptProbeAttempts: opts.adoptProbeAttempts ?? 1,
  });
  return { mgr, children, spawns, logs, setHealthy: (b) => (healthy = b), healthyAfterPolls: (n) => { polls = n; healthy = false; }, setAvail: (v) => (avail = v) };
}
const cfgFor = (model: string, extra: Partial<MlxServerConfig> = {}): MlxServerConfig => ({ pythonPath: '/venv/bin/python', model, port: 8123, startupTimeoutMs: 2000, ...extra });

function testArgsAndResolution() {
  const a = buildServerArgs({ port: 8123 }, '/m');
  ok(a.join(' ') === '-m mlx_lm.server --model /m --host 127.0.0.1 --port 8123 --log-level WARNING', `argv is exactly the safe, loopback-only command (got ${a.join(' ')})`);
  ok(buildServerArgs({ port: 1, promptCacheBytes: 4 * 1024 ** 3 }, '/m').includes('--prompt-cache-bytes') && buildServerArgs({ port: 1, promptCacheBytes: 0 }, '/m').indexOf('--prompt-cache-bytes') === -1, 'a prompt-cache cap is passed only when set');
  ok(buildServerArgs({ port: 1, extraArgs: ['--prefill-step-size', '4096'] }, '/m').slice(-2).join(' ') === '--prefill-step-size 4096', 'harmless extra args are appended');
  ok(
    buildServerArgs({ port: 1, prefillStepSize: 2048, extraArgs: ['--prefill-step-size', '4096'] }, '/m').filter((a) => a === '--prefill-step-size').length === 1 &&
      buildServerArgs({ port: 1, prefillStepSize: 2048, extraArgs: ['--prefill-step-size', '4096'] }, '/m').includes('2048'),
    'dedicated prefillStepSize wins over the same flag in extraArgs'
  );
  ok(
    buildServerArgs({ port: 1, promptCacheSize: 8, extraArgs: ['--prompt-cache-size', '99'] }, '/m').slice(-2).join(' ') === '--prompt-cache-size 8',
    'dedicated promptCacheSize wins over the same flag in extraArgs'
  );
  const perf = buildServerArgs({ port: 1, decodeConcurrency: 48, promptConcurrency: 12, draftModel: '/draft', numDraftTokens: 5 }, '/m');
  ok(perf.includes('--decode-concurrency') && perf.includes('48') && perf.includes('--prompt-concurrency') && perf.includes('12'), 'decode/prompt concurrency flags pass through when set');
  ok(perf.includes('--draft-model') && perf.includes('/draft') && perf.slice(-2).join(' ') === '--num-draft-tokens 5', 'draft model and num-draft-tokens pass when draft model is set');
  ok(!buildServerArgs({ port: 1, numDraftTokens: 9 }, '/m').includes('--draft-model'), 'num-draft-tokens is omitted without a draft model');
  for (const bad of ['--trust-remote-code', '--host', '--host=0.0.0.0', '--port', '--model=/evil']) {
    let msg = '';
    try { buildServerArgs({ port: 1, extraArgs: [bad] }, '/m'); } catch (e: any) { msg = e instanceof MlxServerError ? e.message : 'wrong'; }
    ok(/may not contain/.test(msg), `extra arg ${bad} is refused (remote code / host / port / model are managed by Forge)`);
  }
  const dir = makeModelDir();
  ok(resolveModelPath(dir) === dir, 'a local model directory resolves to itself');
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-hf-'));
  const snap = path.join(cache, 'models--org--name', 'snapshots', 'abc123');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'config.json'), MLX_CFG); fs.writeFileSync(path.join(snap, 'model.safetensors'), 'x');
  ok(resolveModelPath('org/name', cache) === snap, 'a Hugging Face repo id resolves to its cached snapshot');
  const snap2 = path.join(cache, 'models--org--name', 'snapshots', 'newer');
  fs.mkdirSync(snap2, { recursive: true });
  fs.writeFileSync(path.join(snap2, 'config.json'), MLX_CFG); fs.writeFileSync(path.join(snap2, 'model.safetensors'), 'x');
  fs.utimesSync(snap2, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
  ok(resolveModelPath('org/name', cache) === snap2, 'with several snapshots, the newest is used');
  let e1 = ''; try { resolveModelPath('org/missing', cache); } catch (e: any) { e1 = e.message; }
  ok(/was not found locally/.test(e1) && /never downloads/.test(e1) && /Searched:/.test(e1), 'a model that is not downloaded gives a clear "offline, never downloads" error with folders searched');
  let e2 = ''; try { resolveModelPath('   '); } catch (e: any) { e2 = e.message; }
  ok(/No MLX model is configured/.test(e2), 'an empty model setting explains what to set');
  ok(modelWeightsBytes(makeModelDir(12345)) === 12345 && modelWeightsBytes('/no/such/dir') === 0, 'weights size is measured (0 for a missing dir)');
}

async function testStartReadyStop() {
  const r = rig();
  const dir = makeModelDir();
  const states: string[] = [];
  r.mgr.onState((s) => states.push(s));
  r.healthyAfterPolls(3);
  await r.mgr.ensure(cfgFor(dir));
  ok(r.mgr.state === 'ready' && states.join(',') === 'starting,ready', `starts, waits for /health, becomes ready (states: ${states.join(',')})`);
  ok(r.spawns.length === 1 && r.spawns[0].cmd === '/venv/bin/python' && r.spawns[0].args.includes('--host') && r.spawns[0].args[r.spawns[0].args.indexOf('--host') + 1] === '127.0.0.1', 'spawned with the configured interpreter, bound to 127.0.0.1');
  ok(r.spawns[0].env.HF_HUB_OFFLINE === '1' && r.spawns[0].env.PYTHONUNBUFFERED === '1', 'runs OFFLINE (HF_HUB_OFFLINE=1) so it can never download anything by itself');
  ok(!r.spawns[0].args.includes('--trust-remote-code'), 'remote code is never enabled');
  r.children[0].stderr.emit('data', Buffer.from('loading weights\nwarming up\n'));
  ok(r.logs.includes('loading weights') && r.logs.includes('warming up') && r.mgr.logTail().includes('warming up'), 'server output is forwarded line by line to the log and kept for error messages');
  const res = r.mgr.resident();
  ok(res.length === 1 && res[0].size === 10, `resident() reports the loaded model for the hardware readout (got ${JSON.stringify(res)})`);
  await r.mgr.ensure(cfgFor(dir));
  ok(r.spawns.length === 1, 'ensure() with the same config is a no-op (no second process)');
  await r.mgr.stop();
  ok(r.mgr.state === 'stopped' && r.children[0].signals[0] === 'SIGTERM' && r.mgr.resident().length === 0, 'stop() sends SIGTERM and clears the resident model');
  ok(r.children[0].signals.length === 1, 'a child that exits on SIGTERM is not also SIGKILLed');
}

async function testKillEscalation() {
  const r = rig();
  const dir = makeModelDir();
  r.setHealthy(false); r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(dir));
  r.children[0].ignoreTerm = true;
  await r.mgr.stop();
  ok(r.children[0].signals.join(',') === 'SIGTERM,SIGKILL' && r.mgr.state === 'stopped', 'a child that ignores SIGTERM is SIGKILLed after the grace period (no orphan process)');
}

async function testCrashes() {
  // exits before ever becoming healthy
  const r = rig();
  const dir = makeModelDir();
  const p = r.mgr.ensure(cfgFor(dir));
  await sleep(10);
  r.children[0].stderr.emit('data', 'ImportError: no module named mlx_lm\n');
  r.children[0].die(1);
  let err: any;
  try { await p; } catch (e) { err = e; }
  ok(err instanceof MlxServerError && /exited during start-up/.test(err.message) && /no module named mlx_lm/.test(err.message), `a crash during start-up is reported with the server's own last output (got ${JSON.stringify(String(err?.message).slice(0, 120))})`);
  ok(r.mgr.state === 'crashed' && !!r.mgr.lastError, 'state is crashed with an error message');
  // a later ensure() starts a fresh process
  r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(dir));
  ok(r.mgr.state === 'ready' && r.spawns.length === 2, 'after a crash, ensure() starts a clean new server');
  // crash AFTER ready
  r.children[1].die(139, 'SIGSEGV');
  ok(r.mgr.state === 'crashed' && /exited unexpectedly/.test(r.mgr.lastError || ''), 'a crash after ready is detected immediately');
  r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(dir));
  ok(r.mgr.state === 'ready' && r.spawns.length === 3, 'and the next ensure() recovers');
  // never becomes healthy → timeout kills it
  const t = rig();
  t.setHealthy(false);
  let te: any;
  try { await t.mgr.ensure(cfgFor(makeModelDir(), { startupTimeoutMs: 40 })); } catch (e) { te = e; }
  ok(te instanceof MlxServerError && /did not become ready/.test(te.message) && t.children[0].signals.includes('SIGTERM') && t.mgr.state === 'crashed', 'a server that never gets healthy times out and is killed');
  // spawn itself fails
  const bad = new MlxServerManager({ spawn: () => { throw new Error('ENOENT: no such python'); }, isHealthy: async () => false, sleep: async () => {} });
  let se: any; try { await bad.ensure(cfgFor(makeModelDir())); } catch (e) { se = e; }
  ok(se instanceof MlxServerError && /Could not start/.test(se.message) && bad.state === 'crashed', 'a missing interpreter gives a clear error');
}

async function testRestartAdoptSerialize() {
  const r = rig();
  const d1 = makeModelDir(), d2 = makeModelDir();
  r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(d1));
  r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(d2));
  ok(r.spawns.length === 2 && r.children[0].signals.includes('SIGTERM') && r.mgr.state === 'ready', 'changing the model stops the old server and starts a new one');
  r.healthyAfterPolls(1);
  await r.mgr.ensure(cfgFor(d2, { port: 9000 }));
  ok(r.spawns.length === 3 && r.spawns[2].args.includes('9000'), 'changing the port restarts on the new port');
  // concurrent callers share one start
  const c = rig();
  const d = makeModelDir();
  c.healthyAfterPolls(4);
  await Promise.all([c.mgr.ensure(cfgFor(d)), c.mgr.ensure(cfgFor(d)), c.mgr.ensure(cfgFor(d))]);
  ok(c.spawns.length === 1 && c.mgr.state === 'ready', 'three concurrent ensure() calls result in ONE process (serialized)');
  // adopt an external server
  const x = rig({ adoptExternal: true });
  await x.mgr.ensure(cfgFor(makeModelDir()));
  ok(x.spawns.length === 0 && x.mgr.state === 'ready' && x.logs.some((l) => /adopting/.test(l)), 'a healthy server already on the port is ADOPTED, not duplicated');
  await x.mgr.stop();
  ok(x.children.length === 0 && x.mgr.state === 'stopped', 'and stopping never kills a server Forge did not start');
  // adopt a server that is slow to answer (e.g. busy under load) rather than mistaking silence for a free port
  const slow = rig({ adoptProbeAttempts: 3 });
  slow.healthyAfterPolls(2); // fails the first 2 probes, healthy on the 3rd — must still be adopted, not double-spawned
  await slow.mgr.ensure(cfgFor(makeModelDir()));
  ok(slow.spawns.length === 0 && slow.mgr.state === 'ready' && slow.logs.some((l) => /adopting/.test(l)), 'a server slow to answer 2 health checks is still adopted on the 3rd try, not duplicated');
  const gone = rig({ adoptProbeAttempts: 3 });
  gone.healthyAfterPolls(3); // fails all 3 adopt probes (port really is free), then the newly spawned server answers normally
  await gone.mgr.ensure(cfgFor(makeModelDir()));
  ok(gone.spawns.length === 1 && gone.mgr.state === 'ready', 'a port that fails all 3 adopt probes is treated as free and a server is started');
  // dispose kills a managed child
  const dsp = rig();
  dsp.healthyAfterPolls(1);
  await dsp.mgr.ensure(cfgFor(makeModelDir()));
  dsp.mgr.dispose();
  ok(dsp.children[0].signals[0] === 'SIGTERM', 'dispose() (extension deactivation) terminates the managed server');
}

async function testMemoryGuard() {
  const dir = makeModelDir(4 * 1024 ** 3); // sparse 4 GB "weights"
  const low = rig();
  low.setAvail(2);
  let e: any; try { await low.mgr.ensure(cfgFor(dir)); } catch (x) { e = x; }
  ok(e instanceof MlxServerError && /Not enough free memory/.test(e.message) && /4\.0 GB/.test(e.message) && low.spawns.length === 0, `too little free memory: refuses BEFORE loading anything, with a useful message (got ${JSON.stringify(String(e?.message).slice(0, 110))})`);
  const enough = rig();
  enough.setAvail(20); enough.healthyAfterPolls(1);
  await enough.mgr.ensure(cfgFor(dir));
  ok(enough.mgr.state === 'ready', 'enough free memory: proceeds');
  const unknown = rig();
  unknown.setAvail(undefined); unknown.healthyAfterPolls(1);
  await unknown.mgr.ensure(cfgFor(dir));
  ok(unknown.mgr.state === 'ready', 'unknown free memory: proceeds (the check is skipped, never guessed)');
  const boundary = rig();
  boundary.setAvail(4 * 1.15 + 1.5 + 0.1); boundary.healthyAfterPolls(1);
  await boundary.mgr.ensure(cfgFor(dir));
  ok(boundary.mgr.state === 'ready', 'just above the safety margin (1.15× model + 1.5 GB) is allowed');
}

async function testEnsureFunction() {
  const calls: MlxServerConfig[] = [];
  const mgr: any = { ensure: async (c: MlxServerConfig) => { calls.push(c); } };
  const base = { provider: 'mlx', mlxBaseUrl: 'http://127.0.0.1:8123', mlxModel: 'org/m', mlxPythonPath: '/py', mlxAutoStart: true, mlxPromptCacheGB: 4, mlxPrefillStepSize: 0, mlxPromptCacheSize: 0, mlxExtraArgs: ['--x'] };
  let cfg = { ...base };
  const ensure = makeEnsureMlx(() => cfg, mgr, async () => false, (c) => c || 'python3');
  await ensure();
  ok(calls.length === 1 && calls[0].port === 8123 && calls[0].pythonPath === '/py' && calls[0].model === 'org/m' && calls[0].promptCacheBytes === 4 * 1024 ** 3 && calls[0].extraArgs![0] === '--x', 'on MLX with a model: the manager is asked for exactly the current settings');
  cfg = { ...base, provider: 'ollama' }; await ensure();
  cfg = { ...base, mlxAutoStart: false }; await ensure();
  cfg = { ...base, mlxBaseUrl: 'http://10.0.0.5:8123' }; await ensure();
  cfg = { ...base, mlxBaseUrl: 'not a url' }; await ensure();
  ok(calls.length === 1, 'not on MLX / autoStart off / a remote or invalid URL → nothing is managed (a remote server is used as-is)');
  cfg = { ...base, mlxPromptCacheGB: 0 }; await ensure();
  ok(calls[1].promptCacheBytes === undefined, 'a 0 GB cache setting means "server default" (no flag)');
  cfg = { ...base, mlxModel: '' };
  let msg = ''; try { await ensure(); } catch (e: any) { msg = e.message; }
  ok(/No MLX model is configured/.test(msg) && calls.length === 2, 'no model and nothing running: a clear instruction, nothing spawned');
  const adopt = makeEnsureMlx(() => cfg, mgr, async () => true, (c) => c);
  await adopt();
  ok(calls.length === 2, 'no model configured but a healthy server is already running (user-started): use it, manage nothing');
  ok(parseLocalServerUrl('http://localhost:9000')!.isLoopback && parseLocalServerUrl('http://localhost:9000')!.port === 9000 && !parseLocalServerUrl('http://192.168.1.2:1')!.isLoopback && parseLocalServerUrl('nope') === undefined, 'URL parsing: loopback vs remote, port, garbage');
  ok(resolvePython('/custom/python', () => false) === '/custom/python' && resolvePython('', () => true, '/h') === '/h/.forge/mlx-venv/bin/python' && resolvePython('', () => false, '/h') === 'python3', 'python: configured wins, else ~/.forge/mlx-venv if present, else python3');
}

async function main() {
  testArgsAndResolution();
  await testStartReadyStop();
  await testKillEscalation();
  await testCrashes();
  await testRestartAdoptSerialize();
  await testMemoryGuard();
  await testEnsureFunction();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 MLX server manager tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 MLX server manager tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_mlxserver.ts:', err); process.exit(1); });
