// ============================================================================
// 0.15.0 (P0-6): per-iteration trace log + redundant-read detection.
//   - ReadCoverage (src/agent/readCoverage.ts): pure range tracking, the basis of the "reads the whole file several times" measurement.
//   - TraceWriter / argsHash (src/agent/traceLog.ts): JSONL, ordered, rotating, best-effort (a broken sink must never break a turn), no file contents.
//   - Integration: the REAL agent loop driven by a scripted fake model, asserting what lands in the trace.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadCoverage } from '../../src/agent/readCoverage';
import { TraceWriter, argsHash, describeArgsForTrace, tracePathFor } from '../../src/agent/traceLog';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { AgentEvent } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}

function testReadCoverage() {
  const c = new ReadCoverage();
  ok(c.note({ path: 'a.ts' }).redundant === false, 'first whole-file read is not redundant');
  ok(c.note({ path: 'a.ts' }).redundant === true, 'a second whole-file read of the same file IS redundant');
  ok(c.note({ path: 'a.ts', startLine: 10, endLine: 20 }).redundant === true, 'a sub-range of an already-read whole file is redundant');
  ok(c.note({ path: 'b.ts' }).redundant === false, 'a different file is independent');

  const r = new ReadCoverage();
  ok(r.note({ path: 'x', startLine: 1, endLine: 100 }).redundant === false, 'range read #1 not redundant');
  const partial = r.note({ path: 'x', startLine: 50, endLine: 150 });
  ok(partial.redundant === false && Math.abs(partial.coveredFraction - 51 / 101) < 1e-9, `partly overlapping read is not redundant, fraction ~0.5 (got ${partial.coveredFraction.toFixed(3)})`);
  ok(r.note({ path: 'x', startLine: 1, endLine: 150 }).redundant === true, 'ranges merge: 1-100 then 50-150 now covers 1-150');
  ok(r.note({ path: 'x', startLine: 151, endLine: 160 }).redundant === false, 'adjacent-but-uncovered lines are new');
  ok(r.note({ path: 'x', startLine: 1, endLine: 160 }).redundant === true, 'adjacent ranges (…150) + (151…) merge into one');
  ok(r.note({ path: 'x' }).redundant === false, 'a whole-file read after only partial coverage is NOT redundant (the tail is unseen)');

  const w = new ReadCoverage();
  w.note({ path: 'f' });
  w.invalidate('f');
  ok(w.note({ path: 'f' }).redundant === false, 'after invalidate() (a write) the same read is new again');
  w.note({ path: 'g' }); w.note({ path: 'h' });
  w.clear();
  ok(w.note({ path: 'g' }).redundant === false && w.note({ path: 'h' }).redundant === false, 'clear() (after a shell command) forgets every file');
  ok(new ReadCoverage().note({ path: 'z', startLine: 5, endLine: 2 }).redundant === false, 'an inverted range does not throw');
  ok(new ReadCoverage().note({ path: 'z', startLine: 0, endLine: 3 }).coveredFraction === 0, 'line numbers below 1 are clamped');
}

function testArgsAndPaths() {
  ok(argsHash({ a: 1, b: { x: 2, y: 3 } }) === argsHash({ b: { y: 3, x: 2 }, a: 1 }), 'argsHash ignores key order (also nested)');
  ok(argsHash({ path: 'a' }) !== argsHash({ path: 'b' }), 'different args → different hash');
  ok(argsHash({ path: 'a' }).length === 10 && !argsHash({ secret: 'hunter2' }).includes('hunter2'), 'hash is short and does not contain the arguments');
  ok(argsHash(undefined) === argsHash(undefined) && typeof argsHash(null) === 'string', 'undefined/null args do not throw');
  const d = describeArgsForTrace('read_file', { path: 'src/a.ts', start_line: 5, end_line: 9, content: 'SECRET FILE TEXT' });
  ok(d.path === 'src/a.ts' && d.range === '5-9', 'path and range extracted');
  ok(!JSON.stringify(d).includes('SECRET'), 'no content leaks into the described args');
  ok(describeArgsForTrace('read_file', { file: 'x' }).path === 'x', 'legacy "file" arg is understood');
  ok(describeArgsForTrace('run_command', { command: 'ls' }).path === undefined, 'a command\'s text is not recorded as a path');
  ok(describeArgsForTrace('read_file', { path: 'q', start_line: 3 }).range === '3-end', 'open-ended range is labelled');
  ok(tracePathFor('/repo', 'sess/../x').endsWith(path.join('.forge', 'traces', 'sess_.._x.jsonl')) && !tracePathFor('/repo', '../../etc').includes('..' + path.sep), 'session ids cannot escape .forge/traces');
}

async function testWriter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-'));
  const file = path.join(dir, 'nested', 't.jsonl');
  const w = new TraceWriter(file, 'sess1');
  const base = { turnId: 't', iter: 0, depth: 0, model: 'm', mode: 'agent', promptChars: 1, promptMsgs: 1, staleReadStubs: 0, compacted: false, modelMs: 1 };
  for (let i = 0; i < 20; i++) w.write({ ...base, iter: i });
  await w.flush();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.length === 20 && lines.every((l, i) => l.iter === i), 'all records written, in order, one JSON object per line');
  ok(lines[0].v === 1 && lines[0].sessionId === 'sess1' && typeof lines[0].ts === 'string', 'writer stamps version, session id and timestamp');

  const small = new TraceWriter(path.join(dir, 'rot.jsonl'), 's', 300);
  for (let i = 0; i < 12; i++) small.write({ ...base, iter: i });
  await small.flush();
  ok(fs.existsSync(path.join(dir, 'rot.jsonl.1')) && fs.statSync(path.join(dir, 'rot.jsonl')).size <= 300 + 400, 'exceeding the size cap rotates to .1 instead of growing without bound');

  // a sink that cannot be written must never throw
  const blocker = path.join(dir, 'iamafile');
  fs.writeFileSync(blocker, 'x');
  const bad = new TraceWriter(path.join(blocker, 'sub', 't.jsonl'), 's');
  let threw = false;
  try { bad.write(base as any); await bad.flush(); } catch { threw = true; }
  ok(!threw, 'an unwritable trace path is swallowed (tracing never breaks a turn)');
}

// ------------------------------- integration with the real agent loop -------------------------------
function workspaceWith(files: Record<string, string>): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-ws-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(tmp, f), c);
  return vscode.Uri.file(tmp);
}

function depsFor(workspaceRoot: vscode.Uri, events: AgentEvent[], ollama: any, trace?: TraceWriter) {
  const l = new TaskLedger();
  return {
    ollama,
    pendingEdits: new PendingEditManager(workspaceRoot),
    approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRoot),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    taskLedger: { addTasks: (t: any[]) => t.map((x) => l.add(typeof x === 'string' ? x : x.description).id), updateTask: () => true, list: () => l.list() },
    trace,
    workspaceRoot,
    workspaceName: 'test',
  } as any;
}

/** A scripted fake model: returns each reply in turn and reports Ollama-style metrics via onMetrics, like the real client. */
function scripted(replies: string[]) {
  let i = 0;
  return {
    chat: async (opts: any) => {
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      opts.onMetrics?.({ model: 'fake', promptTokens: 100 + i, evalTokens: 10, tokensPerSecond: 20, promptEvalDurationMs: 50, loadDurationMs: 0, totalDurationMs: 100 });
      return reply;
    },
  };
}
const act = (tool: string, args: any) => '```forge_action\n' + JSON.stringify({ tool, args }) + '\n```';
const readTraces = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function testAgentLoopTrace() {
  const SECRET = 'TOP-SECRET-FILE-CONTENT-12345';
  const ws = workspaceWith({ 'a.txt': `line1\n${SECRET}\nline3\n` });
  const file = tracePathFor(ws.fsPath, 'sessX');
  const writer = new TraceWriter(file, 'sessX');
  const events: AgentEvent[] = [];
  const model = scripted([
    act('read_file', { path: 'a.txt' }),
    act('read_file', { path: 'a.txt' }), // redundant
    act('read_file', { path: 'a.txt', start_line: 1, end_line: 2 }), // redundant sub-range
    act('write_file', { path: 'a.txt', search: 'line1', replace: 'LINE-ONE' }),
    act('read_file', { path: 'a.txt' }), // NOT redundant: the file changed
    'All done.',
  ]);
  await runAgentTurn([], 'inspect and edit', depsFor(ws, events, model, writer), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  await writer.flush();
  const rec = readTraces(file);
  ok(rec.length === 6, `one trace record per iteration (5 tool calls + the final answer = 6, got ${rec.length})`);
  ok(rec.map((r) => r.tool || (r.final ? 'FINAL' : '?')).join(',') === 'read_file,read_file,read_file,write_file,read_file,FINAL', `tools recorded in order (got ${rec.map((r) => r.tool || (r.final ? 'FINAL' : '?')).join(',')})`);
  ok(rec[0].redundantRead === false, 'first read is not redundant');
  ok(rec[1].redundantRead === true, 'the identical second whole-file read is flagged redundant');
  ok(rec[2].redundantRead === true, 'a sub-range of an already-read file is flagged redundant');
  ok(rec[3].tool === 'write_file' && rec[3].redundantRead === undefined, 'write_file records no redundancy flag');
  ok(rec[4].redundantRead === false, 'after a write to the file, re-reading it is NOT redundant (coverage invalidated)');
  ok(rec.every((r) => r.sessionId === 'sessX' && r.depth === 0 && r.mode === 'auto' && r.model === 'fake'), 'session, depth, mode and model recorded on every record');
  ok(rec[0].promptTokens === 101 && rec[0].evalTokens === 10 && rec[0].tokPerSec === 20 && rec[0].promptEvalMs === 50, `model metrics from the runtime are captured (got ${JSON.stringify({ p: rec[0].promptTokens, e: rec[0].evalTokens, t: rec[0].tokPerSec, pe: rec[0].promptEvalMs })})`);
  ok(rec.every((r) => typeof r.modelMs === 'number' && r.modelMs >= 0 && r.promptChars > 0 && r.promptMsgs >= 2), 'model time and prompt size recorded every iteration');
  ok(rec.slice(0, 5).every((r) => typeof r.toolMs === 'number' && typeof r.resultChars === 'number' && r.ok === true), 'tool time, result size and ok recorded for every tool call');
  ok(rec[0].argsHash === rec[1].argsHash && rec[0].argsHash !== rec[2].argsHash, 'identical calls share an args hash; a different range does not');
  ok(rec[2].range === '1-2' && rec[0].path === 'a.txt', 'path and line range recorded');
  ok(rec[5].final === true, 'the last record is marked final');
  ok(!fs.readFileSync(file, 'utf8').includes(SECRET), 'file CONTENTS never appear in the trace');
  ok(!fs.readFileSync(file, 'utf8').includes('LINE-ONE'), 'edit text never appears in the trace');
}

async function testPruningStubsAreCounted() {
  const files: Record<string, string> = {};
  for (let i = 0; i < 9; i++) files[`f${i}.txt`] = `content ${i}\n`;
  const ws = workspaceWith(files);
  const file = tracePathFor(ws.fsPath, 'sessP');
  const writer = new TraceWriter(file, 'sessP');
  const replies = Array.from({ length: 9 }, (_, i) => act('read_file', { path: `f${i}.txt` })).concat(['done']);
  await runAgentTurn([], 'read everything', depsFor(ws, [], scripted(replies), writer), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  await writer.flush();
  const rec = readTraces(file);
  ok(rec[0].staleReadStubs === 0, 'early in the turn nothing has been pruned yet');
  ok(rec[rec.length - 1].staleReadStubs >= 1, `by the end, old reads have been replaced by "superseded" stubs and the trace counts them (got ${rec[rec.length - 1].staleReadStubs}) — each is a future re-read risk`);
  ok(rec.every((r) => r.compacted === false), 'no compaction on a small session');
}

async function testTraceCannotBreakATurn() {
  const ws = workspaceWith({ 'a.txt': 'x\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trace-bad-'));
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  const badWriter = new TraceWriter(path.join(dir, 'blocker', 'sub', 't.jsonl'), 's');
  const events: AgentEvent[] = [];
  await runAgentTurn([], 'go', depsFor(ws, events, scripted([act('read_file', { path: 'a.txt' }), 'finished']), badWriter), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  ok(events.some((e) => e.type === 'final'), 'a turn still completes normally when the trace sink is unwritable');
  const exploding: any = { write: () => { throw new Error('boom'); } };
  const ev2: AgentEvent[] = [];
  await runAgentTurn([], 'go', depsFor(ws, ev2, scripted([act('read_file', { path: 'a.txt' }), 'finished']), exploding), (e) => ev2.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  ok(ev2.some((e) => e.type === 'final'), 'a turn still completes when trace.write() THROWS');
  const ev3: AgentEvent[] = [];
  await runAgentTurn([], 'go', depsFor(ws, ev3, scripted([act('read_file', { path: 'a.txt' }), 'finished']), undefined), (e) => ev3.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  ok(ev3.some((e) => e.type === 'final'), 'tracing disabled (no sink) is a no-op');
  const tp = tracePathFor(ws.fsPath, 'never');
  ok(!fs.existsSync(tp), 'no trace file is created when tracing is off');
}

async function testSubAgentDepthAndNotes() {
  const ws = workspaceWith({ 'a.txt': 'x\n' });
  const file = tracePathFor(ws.fsPath, 'sessS');
  const writer = new TraceWriter(file, 'sessS');
  // one unknown tool → a 'note' record, then a final
  await runAgentTurn([], 'go', depsFor(ws, [], scripted([act('no_such_tool', {}), 'ok done']), writer), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  await writer.flush();
  const rec = readTraces(file);
  ok(rec[0].tool === 'no_such_tool' && rec[0].ok === false && /unknown/.test(rec[0].note || ''), 'an unknown-tool step is recorded with ok:false and a note');
}

async function main() {
  testReadCoverage();
  testArgsAndPaths();
  await testWriter();
  await testAgentLoopTrace();
  await testPruningStubsAreCounted();
  await testTraceCannotBreakATurn();
  await testSubAgentDepthAndNotes();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 trace tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 trace tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_trace.ts:', err); process.exit(1); });
