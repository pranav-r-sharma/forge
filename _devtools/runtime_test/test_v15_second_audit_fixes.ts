// Second harness audit fixes (2026-09-30) — unit tests only.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn, checkLoop } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { LoopDetector } from '../../src/agent/loopDetector';
import { formatRequirementsFinalUnmetSection } from '../../src/agent/requirements';
import { runVerifyCommand } from '../../src/agent/verifyCheck';
import { writeFileTool } from '../../src/tools/fileTools';
import { getConfig } from '../../src/util/config';
import { thinkingForStep } from '../../src/agent/agentLoop';
import {
  activeAgentTurnCount,
  isMlxRestartPending,
  notifyAgentTurnEnded,
  notifyAgentTurnStarted,
  registerMlxEnsureRunner,
  requestMlxRestartAfterSettingsChange,
  resetMlxRestartCoordForTests,
} from '../../src/llm/mlxRestartCoord';
import { AgentEvent } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}
const vs: any = vscode;

function deps(root: vscode.Uri, ollama: any) {
  return {
    ollama,
    pendingEdits: new PendingEditManager(root),
    approvalBroker: new ApprovalBroker(() => {}, () => [], () => false),
    hooks: new HookRunner(root),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    taskLedger: { addTasks: () => [], updateTask: () => true, list: () => [] },
    workspaceRoot: root,
    workspaceName: 't',
  } as any;
}

function testThinkingDefaultConfig() {
  vs.__resetConfig();
  vs.__setConfig({ 'forge.thinking': 'default' });
  ok(getConfig().thinking === 'default' && thinkingForStep('default', 0) === undefined, 'thinking default → model default (undefined)');
  vs.__resetConfig();
}

function testRequirementsFinalSection() {
  const text = formatRequirementsFinalUnmetSection([
    { id: 1, text: 'Add tests', kind: 'checkable', status: 'open' },
    { id: 2, text: 'Looks good', kind: 'judgment', status: 'open' },
  ]);
  ok(text.includes('Unmet requirements') && text.includes('1. Add tests') && !text.includes('2. Looks good'), 'final section lists checkable gaps only');
}

function testMlxRestartDeferral() {
  resetMlxRestartCoordForTests();
  let ensureCalls = 0;
  registerMlxEnsureRunner(async () => {
    ensureCalls++;
  });
  notifyAgentTurnStarted();
  requestMlxRestartAfterSettingsChange();
  ok(isMlxRestartPending() && ensureCalls === 0 && activeAgentTurnCount() === 1, 'restart deferred while a turn is active');
  notifyAgentTurnEnded();
  ok(!isMlxRestartPending() && ensureCalls === 1, 'restart runs when the turn ends');
  resetMlxRestartCoordForTests();
}

async function testLoopCapEmitsFinal() {
  const detector = new LoopDetector({ consecutiveLimit: 2 });
  const ev: AgentEvent[] = [];
  const emit = (e: AgentEvent) => ev.push(e);
  const sig = { command: 'true' };
  let stopped = false;
  for (let i = 0; i < 4 && !stopped; i++) {
    stopped = checkLoop(detector, 'run_command', sig, true, 'same', emit, {});
  }
  ok(stopped && ev.some((e) => e.type === 'final') && ev.some((e) => e.type === 'done') && !ev.some((e) => e.type === 'error'), 'loop hard stop emits final+done (not error)');
}

async function testAppendSizeGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-append-'));
  const root = vscode.Uri.file(dir);
  const rel = 'big.txt';
  const uri = vscode.Uri.file(path.join(dir, rel));
  const chunk = 'x'.repeat(1024);
  fs.writeFileSync(uri.fsPath, chunk);
  vs.__setConfig({ 'forge.maxContextFileKB': 1, 'forge.requireApprovalForWrites': false });
  const pending = new PendingEditManager(root);
  const ctx = {
    workspaceRoot: root,
    cancellation: new vscode.CancellationTokenSource().token,
    proposeEdit: (e: any) => pending.propose(e, false),
    readEffective: (u: vscode.Uri) => pending.readEffective(u),
    config: getConfig(),
  } as any;
  const r = await writeFileTool({ path: rel, content: 'y'.repeat(2048), append: true }, ctx);
  ok(!r.ok && /maxContextFileKB|limit/i.test(r.content), 'append rejected when existing+append exceeds maxContextFileKB');
  vs.__resetConfig();
}

async function testVerifyCancelResolves() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-'));
  const cts = new vscode.CancellationTokenSource();
  const p = runVerifyCommand('sleep 30', dir, cts.token, 60_000);
  await new Promise((r) => setTimeout(r, 50));
  cts.cancel();
  const t0 = Date.now();
  const result = await p;
  ok(!result.ok && Date.now() - t0 < 5000, 'verify settles quickly after cancel (process-group kill path)');
}

async function main() {
  testThinkingDefaultConfig();
  testRequirementsFinalSection();
  testMlxRestartDeferral();
  await testLoopCapEmitsFinal();
  await testAppendSizeGuard();
  await testVerifyCancelResolves();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
