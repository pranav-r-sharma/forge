// Headless end-to-end runner: drives Forge's REAL agent loop + REAL tools against a REAL model (MLX or Ollama) on a task from _devtools/e2e/tasks/.
// It reuses the fs-backed vscode stub, so nothing here needs VS Code. Writes a JSON result + a per-iteration trace.
//
// usage: node _devtools/run-ts.js _devtools/bench/run_task.ts --task t01-fix-bug --provider mlx --model <snapshot-dir> --out <result.json>
//          [--thinking default|off|on] [--ctx 32768] [--max-iters 40] [--timeout-s 900] [--append-only true|false] [--port 8126] [--keep]
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { BackgroundProcessManager } from '../../src/tools/backgroundProcessManager';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { TraceWriter } from '../../src/agent/traceLog';
import { OpenAiCompatClient } from '../../src/llm/openaiCompatClient';
import { OllamaClient } from '../../src/ollama/client';
import { MlxServerManager } from '../../src/llm/mlxServer';
import { HwSampler, readMemorySample } from '../../src/util/hwSampler';
import { keywordCodebaseSearch } from '../../src/indexing/keywordSearch';
import { AgentEvent } from '../../src/agent/types';
import { LlmProvider } from '../../src/llm/provider';

const vs: any = vscode;
const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; };
const flag = (name: string) => process.argv.includes('--' + name);
const repoRoot = path.resolve(__dirname, '..', '..');

function copyDir(src: string, dst: string) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const s = path.join(src, e.name), d = path.join(dst, e.name); if (e.isDirectory()) { if (e.name !== '__pycache__') copyDir(s, d); } else fs.copyFileSync(s, d); } }
function listFiles(dir: string, base = dir): Record<string, string> { const out: Record<string, string> = {}; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== '__pycache__' && e.name !== '.forge') Object.assign(out, listFiles(p, base)); } else out[path.relative(base, p)] = fs.readFileSync(p, 'utf8'); } return out; }

async function main() {
  const taskId = arg('task')!;
  const provider = (arg('provider', 'mlx') as 'mlx' | 'ollama');
  const model = arg('model')!;
  const outFile = arg('out')!;
  const thinking = arg('thinking', 'default')!;
  const ctx = Number(arg('ctx', '32768'));
  const maxIters = Number(arg('max-iters', '40'));
  const timeoutS = Number(arg('timeout-s', '900'));
  const appendOnly = arg('append-only', 'true') === 'true';
  const port = Number(arg('port', '8126'));
  const taskDir = path.join(repoRoot, '_devtools', 'e2e', 'tasks', taskId);
  const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8'));
  const taskText = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf8').trim();

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `forge-e2e-${taskId}-`));
  copyDir(path.join(taskDir, 'repo'), ws);
  const before = listFiles(ws);
  vs.workspace.__setWorkspaceRoot(ws);
  vs.__setConfig({
    'forge.temperature': 0, 'forge.thinking': thinking, 'forge.provider': provider === 'mlx' ? 'mlx' : 'ollama', 'forge.mlx.contextTokens': ctx, 'forge.numCtx': ctx,
    'forge.maxAgentIterations': maxIters, 'forge.autoModeMaxIterations': maxIters, 'forge.context.appendOnly': appendOnly,
    'forge.loopDetection.enabled': true,
  });

  const result: any = { task: taskId, provider, model: path.basename(model), thinking, ctx, appendOnly, maxIters, timeoutS, startedAt: new Date().toISOString(), hardware: 'Apple M5, 32 GB' };
  const outDir = path.dirname(outFile);
  fs.mkdirSync(outDir, { recursive: true });
  const tracePath = outFile.replace(/\.json$/, '.trace.jsonl');
  try { fs.unlinkSync(tracePath); } catch { /* none */ }

  let llm: LlmProvider;
  let mgr: MlxServerManager | undefined;
  const tServer = Date.now();
  if (provider === 'mlx') {
    mgr = new MlxServerManager({ log: () => {}, availableGB: async () => (await readMemorySample())?.availableGB });
    await mgr.ensure({ pythonPath: path.join(repoRoot, '_devtools/mlx-venv/bin/python'), model, port, promptCacheBytes: 4 * 1024 ** 3, startupTimeoutMs: 240_000 });
    llm = new OpenAiCompatClient({ getBaseUrl: () => `http://127.0.0.1:${port}`, kind: 'mlx' });
  } else {
    llm = new OllamaClient(() => 'http://localhost:11434');
  }
  result.serverReadyS = (Date.now() - tServer) / 1000;

  const sampler = new HwSampler();
  sampler.start(1000);
  await sampler.sampleOnce();
  const writer = new TraceWriter(tracePath, taskId);
  const events: AgentEvent[] = [];
  const ledger = new TaskLedger();
  const root = vscode.Uri.file(ws);
  const deps: any = {
    ollama: llm, pendingEdits: new PendingEditManager(root), approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false), hooks: new HookRunner(root),
    codebaseSearch: (q: string, k: number) => keywordCodebaseSearch(root, q, k), rememberFact: async () => ({ added: false }), chatMemorySearch: async () => [],
    backgroundProcesses: new BackgroundProcessManager(), mcpTools: [],
    taskLedger: { addTasks: (t: any[]) => t.map((x) => ledger.add(typeof x === 'string' ? x : x.description).id), updateTask: () => true, list: () => ledger.list() },
    trace: writer, hw: () => sampler.latest(), workspaceRoot: root, workspaceName: taskId,
  };
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => { result.timedOut = true; cts.cancel(); }, timeoutS * 1000);
  let step = 0;
  const t0 = Date.now();
  let finalText = '';
  try {
    await runAgentTurn([], taskText, deps, (e: AgentEvent) => {
      events.push(e);
      if (e.type === 'tool_call') { step++; console.log(`  step ${step}: ${e.tool} ${JSON.stringify(e.args).slice(0, 110)}`); }
      if (e.type === 'tool_result') console.log(`     → ${e.ok ? 'ok' : 'FAIL'} ${e.summary.slice(0, 90)}`);
      if (e.type === 'final') finalText = e.text;
      if (e.type === 'error') { result.agentError = e.message; console.log('  ERROR:', e.message); }
    }, cts.token, provider === 'mlx' ? 'default_model' : model, { mode: 'auto', numCtx: ctx, maxIterationsOverride: maxIters });
  } catch (err: any) {
    result.crash = String(err?.stack || err);
  }
  clearTimeout(timer);
  result.wallS = (Date.now() - t0) / 1000;
  await writer.flush();
  sampler.stop();

  // ---- verify ----
  const after = listFiles(ws);
  const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f]);
  const protectedTouched = (meta.protected || []).filter((f: string) => before[f] !== after[f]);
  const chk = spawnSync('bash', [path.join(taskDir, 'check.sh')], { cwd: ws, encoding: 'utf8', timeout: 120_000 });
  result.checkExit = chk.status;
  result.checkOutput = String((chk.stdout || '') + (chk.stderr || '')).trim().split('\n').slice(-6).join('\n');
  result.protectedTouched = protectedTouched;
  result.filesChanged = changed;
  result.pass = chk.status === 0 && protectedTouched.length === 0;
  result.finalText = finalText.slice(0, 400);

  // ---- summarize the trace ----
  const recs = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const sum = (k: string) => recs.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : 0), 0);
  const tools: Record<string, number> = {};
  for (const r of recs) if (r.tool) tools[r.tool] = (tools[r.tool] || 0) + 1;
  const evaluated = sum('promptTokens'), cached = sum('cachedTokens');
  result.iterations = recs.length;
  result.tools = tools;
  result.toolFailures = recs.filter((r) => r.tool && r.ok === false).length;
  result.redundantReads = recs.filter((r) => r.redundantRead).length;
  result.reads = tools['read_file'] || 0;
  result.viewEvents = recs.filter((r) => r.viewEvent).length;
  result.modelS = +(sum('modelMs') / 1000).toFixed(2);
  result.toolS = +(sum('toolMs') / 1000).toFixed(2);
  result.tokensEvaluated = evaluated;
  result.tokensCached = cached;
  result.cacheHitPct = evaluated + cached > 0 ? +(100 * cached / (evaluated + cached)).toFixed(1) : null;
  result.evalTokens = sum('evalTokens');
  result.promptCharsMax = Math.max(0, ...recs.map((r) => r.promptChars || 0));
  const hw = recs.map((r) => r.hw).filter(Boolean);
  result.hw = { minAvailableGB: Math.min(...hw.map((h: any) => h.availableGB ?? 1e9)), maxSwapGB: Math.max(0, ...hw.map((h: any) => h.swapGB ?? 0)), gpuPeakPct: Math.max(0, ...hw.map((h: any) => h.gpuPeakPct ?? 0)) };
  result.tracePath = path.relative(repoRoot, tracePath);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  if (mgr) await mgr.stop();
  if (!flag('keep')) fs.rmSync(ws, { recursive: true, force: true }); else result.workspace = ws;
  console.log(`\n${result.pass ? 'PASS' : 'FAIL'} ${taskId} [${provider}/${path.basename(model)} thinking=${thinking}] ${result.iterations} iterations, ${result.wallS.toFixed(1)}s (model ${result.modelS}s, tools ${result.toolS}s), cache hit ${result.cacheHitPct}%, reads ${result.reads} (redundant ${result.redundantReads})`);
  process.exit(0);
}
main().catch((e) => { console.error('runner crashed:', e); process.exit(2); });
