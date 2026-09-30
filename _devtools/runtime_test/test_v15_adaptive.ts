// ============================================================================
// 0.15.0: adaptive thinking (forge.thinking = 'auto', the new default). Measured on Ornith-9B/MLX (t03-add-function): thinking OFF is 2-4x faster per
// step but FAILED the task; thinking ON solved it (335 s). 'auto' stays fast until the agent is visibly stuck (2 failed commands in a row), then thinks.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn, thinkingForStep, THINKING_ESCALATION_FAILURES } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { TraceWriter, tracePathFor } from '../../src/agent/traceLog';
import { getConfig } from '../../src/util/config';
import { AgentEvent } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const vs: any = vscode;
const act = (tool: string, args: any) => '```forge_action\n' + JSON.stringify({ tool, args }) + '\n```';

function pureTests() {
  ok(thinkingForStep('default', 5) === undefined, "'default' leaves thinking to the model, whatever happens");
  ok(thinkingForStep('on', 0) === true && thinkingForStep('off', 9) === false, "'on' and 'off' are fixed");
  ok(thinkingForStep('auto', 0) === false && thinkingForStep('auto', THINKING_ESCALATION_FAILURES - 1) === false, "'auto': off while things are going fine (and after a single failure)");
  ok(thinkingForStep('auto', THINKING_ESCALATION_FAILURES) === true && thinkingForStep('auto', 10) === true, "'auto': on once commands have failed repeatedly");
  vs.__resetConfig();
  ok(getConfig().thinking === 'auto', "the default setting is 'auto'");
  vs.__setConfig({ 'forge.thinking': 'off' }); ok(getConfig().thinking === 'off', "'off' is read");
  vs.__setConfig({ 'forge.thinking': 'default' }); ok(getConfig().thinking === 'default', "'default' is preserved (model default via thinkingForStep)");
  vs.__setConfig({ 'forge.thinking': 'nonsense' }); ok(getConfig().thinking === 'auto', 'a garbled value degrades to auto');
  vs.__resetConfig();
}

function deps(root: vscode.Uri, ollama: any, trace?: TraceWriter) {
  const l = new TaskLedger();
  const ev: AgentEvent[] = [];
  return {
    ollama, pendingEdits: new PendingEditManager(root), approvalBroker: new ApprovalBroker((e: AgentEvent) => ev.push(e), () => [], () => false), hooks: new HookRunner(root),
    codebaseSearch: async () => [], rememberFact: async () => ({ added: false }), chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] }, mcpTools: [],
    taskLedger: { addTasks: (t: any[]) => t.map((x) => l.add(typeof x === 'string' ? x : x.description).id), updateTask: () => true, list: () => l.list() },
    trace, workspaceRoot: root, workspaceName: 't',
  } as any;
}

async function loopTest() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-adapt-'));
  const root = vscode.Uri.file(d);
  const seen: (boolean | undefined)[] = [];
  const replies = [
    act('run_command', { command: 'exit 1' }),            // fail #1
    act('run_command', { command: 'exit 1' }),            // fail #2  → next call should think
    act('run_command', { command: 'exit 1 && echo x' }),  // fail #3 (still failing)
    act('run_command', { command: 'true' }),              // success → resets
    act('run_command', { command: 'true && echo again' }),
    'done',
  ];
  let i = 0;
  const model: any = { chat: async (o: any) => { seen.push(o.thinking); o.onMetrics?.({ model: 'f', promptTokens: 1, evalTokens: 1, finishReason: 'stop' }); return replies[Math.min(i++, replies.length - 1)]; } };
  const file = tracePathFor(d, 'ad');
  const w = new TraceWriter(file, 'ad');
  vs.__setConfig({ 'forge.thinking': 'auto', 'forge.loopDetection.enabled': false });
  try {
    await runAgentTurn([], 'go', deps(root, model, w), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  } finally { vs.__resetConfig(); }
  await w.flush();
  ok(seen.join(',') === 'false,false,true,true,false,false', `thinking sequence: off, off, then ON after two failed commands, and back OFF after a success (got ${seen.join(',')})`);
  const rec = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(rec.map((r) => r.thinking).join(',') === seen.join(','), 'the trace records the thinking flag actually sent for each step');
}

async function main() {
  pureTests();
  await loopTest();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 adaptive-thinking tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 adaptive-thinking tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_adaptive.ts:', err); process.exit(1); });
