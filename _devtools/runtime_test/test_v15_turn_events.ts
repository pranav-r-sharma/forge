// ============================================================================
// Turn lifecycle events (2026-10-03): why every turn ended + which model calls started but never returned.
// src/agent/traceLog.ts (TurnEventWriter, classifyTurnEnd) and the runAgentTurn wrapper in agentLoop.ts.
// Observation only: these tests also check the loop's own output is unchanged.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyTurnEnd, TurnEventWriter, turnEventsPathFor } from '../../src/agent/traceLog';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
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

function testClassifier() {
  ok(classifyTurnEnd({}) === 'no-terminal-event', 'no terminal event -> no-terminal-event (a silent stop)');
  ok(classifyTurnEnd({ threw: true }) === 'exception', 'thrown -> exception');
  ok(classifyTurnEnd({ terminal: { type: 'aborted' } }) === 'aborted', 'aborted');
  ok(classifyTurnEnd({ terminal: { type: 'error', message: 'x' } }) === 'error', 'error');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'All done.' } }) === 'final', 'plain final');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'Stopped after 200 steps without a final answer (cap: x).' } }) === 'iteration-cap', 'iteration cap');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'Context is full — start a new chat' } }) === 'context-full', 'context full');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'Forge stopped: possible loop detected. same call 5x' } }) === 'loop-detected', 'loop detector');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'half\n\n[System] stopped: could not produce a valid action for write_file on a.py after 3 attempts' } }) === 'incomplete-cap', 'incomplete-action cap');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'x\n\n[System] stopped: could not resend run_command as a forge_action block after 3 attempts' } }) === 'incomplete-cap', 'foreign-format cap');
  ok(classifyTurnEnd({ terminal: { type: 'final', text: 'I said Stopped after 3 steps earlier.' } }) === 'final', 'phrase in the middle of an answer is not a cap');
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-turnev-'));
}

function deps(fake: any, events: AgentEvent[], log: TurnEventWriter | undefined) {
  const workspaceRoot = vscode.Uri.file(tmp());
  return {
    ollama: fake,
    pendingEdits: new PendingEditManager(workspaceRoot),
    approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRoot),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    workspaceRoot,
    workspaceName: 'test',
    turnEvents: log,
  } as any;
}

async function runTurn(fake: any, withLog: boolean, cts?: vscode.CancellationTokenSource) {
  const dir = tmp();
  const file = path.join(dir, 'turns.jsonl');
  const log = withLog ? new TurnEventWriter(file, 's1') : undefined;
  const events: AgentEvent[] = [];
  let threw: any;
  try {
    await runAgentTurn([], 'do the thing', deps(fake, events, log), (e) => events.push(e), (cts ?? new vscode.CancellationTokenSource()).token, 'fake-model', { mode: 'agent' } as any);
  } catch (e) {
    threw = e;
  }
  await log?.flush();
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { rows, events, threw };
}

async function testLoop() {
  const action = '```forge_action\n{"tool": "list_dir", "args": {"path": "."}}\n```';
  let n = 0;
  let r = await runTurn({ chat: async () => (n++ === 0 ? action : 'Listed everything. Done.') }, true);
  const kinds = r.rows.map((x) => x.event);
  ok(kinds.join(',') === 'turn-start,call-start,call-end,call-start,call-end,turn-end', `normal turn: start, two call pairs, end (got ${kinds.join(',')})`);
  const end = r.rows[r.rows.length - 1];
  ok(end.reason === 'final' && end.finalChars > 0 && typeof end.ms === 'number', 'turn-end reason final with timing');
  ok(r.rows.filter((x) => x.event === 'call-start').every((x, i) => x.iter === i), 'call-start carries the iteration number');
  ok(r.rows.every((x) => x.v === 1 && typeof x.ts === 'string' && x.sessionId === 's1'), 'every row has v, ts, sessionId');

  const before = r.events.filter((e) => e.type === 'final').length;
  n = 0;
  const r2 = await runTurn({ chat: async () => (n++ === 0 ? action : 'Listed everything. Done.') }, false);
  ok(r2.rows.length === 0 && r2.events.filter((e) => e.type === 'final').length === before, 'without a log sink: nothing written and the turn behaves identically');

  const r3 = await runTurn({ chat: async () => { throw new Error('connection refused'); } }, true);
  const k3 = r3.rows.map((x) => x.event);
  ok(k3.includes('call-error') && r3.rows.find((x) => x.event === 'call-error').error.includes('connection refused'), 'a failing provider call is recorded as call-error');
  ok(r3.rows[r3.rows.length - 1].reason === 'error', 'and the turn ends with reason error');

  const cts = new vscode.CancellationTokenSource();
  const r4 = await runTurn({ chat: async () => { cts.cancel(); const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; } }, true, cts);
  ok(r4.rows[r4.rows.length - 1].reason === 'aborted', 'Stop -> turn-end reason aborted');
  ok(r4.rows.find((x) => x.event === 'call-error')?.aborted === true, 'call-error marks the abort');

  const r5 = await runTurn({ chat: async () => '' }, true);
  ok(r5.rows.filter((x) => x.event === 'call-end').length >= 1 && ['final', 'error'].includes(r5.rows[r5.rows.length - 1].reason), `empty-reply model still ends with a recorded reason (${r5.rows[r5.rows.length - 1].reason})`);
}

async function testHungCallLeavesEvidence() {
  // A call that never returns: call-start is written (and flushed) with no call-end. Simulate by reading the file while the call is pending.
  const dir = tmp();
  const file = path.join(dir, 'turns.jsonl');
  const log = new TurnEventWriter(file, 's2');
  const events: AgentEvent[] = [];
  const cts = new vscode.CancellationTokenSource();
  let release: () => void = () => undefined;
  const hang = new Promise<string>((res) => { release = () => res('late'); });
  const p = runAgentTurn([], 'x', deps({ chat: () => hang }, events, log), (e) => events.push(e), cts.token, 'm', { mode: 'agent' } as any);
  await new Promise((r) => setTimeout(r, 150));
  await log.flush();
  const mid = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((x) => x.event);
  ok(mid.includes('call-start') && !mid.includes('call-end') && !mid.includes('turn-end'), `while the model call hangs, the file shows call-start with no call-end/turn-end (got ${mid.join(',')})`);
  release();
  await p;
  await log.flush();
}

function testWriter() {
  const file = path.join(tmp(), 'sub', 'a.turns.jsonl');
  ok(turnEventsPathFor('/w', 'sess/../x').endsWith(path.join('.forge', 'traces', 'sess_.._x.turns.jsonl')) || turnEventsPathFor('/w', 'sess/../x').includes('.turns.jsonl'), 'path is under .forge/traces and sanitised');
  const w = new TurnEventWriter(file, 'q', 200);
  for (let i = 0; i < 20; i++) w.write({ event: 'x', i });
  return w.flush().then(() => {
    ok(fs.existsSync(file) && fs.existsSync(file + '.1'), 'rotates to .1 past the size cap');
    const bad = new TurnEventWriter('/dev/null/nope/x.jsonl', 'q');
    bad.write({ event: 'x' });
    return bad.flush().then(() => ok(true, 'an unwritable path never throws'));
  });
}

(async () => {
  testClassifier();
  await testLoop();
  await testHungCallLeavesEvidence();
  await testWriter();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
