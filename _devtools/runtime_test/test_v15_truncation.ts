// ============================================================================
// 0.15.0: a reply cut off by the output-token limit is INCOMPLETE — it must never be treated as the final answer.
// Found by the first real end-to-end run: mlx_lm.server defaults to 512 output tokens; a chatty model was cut off mid-analysis and the harness
// declared the run finished with nothing done. Now: an explicit forge.maxOutputTokens is sent, the finish reason is captured, and a truncated
// reply is answered with "continue" (bounded), not "done".
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn } from '../../src/agent/agentLoop';
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
const workspace = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trunc-')); fs.writeFileSync(path.join(d, 'a.txt'), 'hello\n'); return vscode.Uri.file(d); };

/** replies: [text, finishReason]; also records every request's options + messages. */
function scripted(replies: [string, string][]) {
  const seen: { maxTokens?: number; thinking?: any; last: string }[] = [];
  let i = 0;
  return {
    seen,
    chat: async (o: any) => {
      seen.push({ maxTokens: o.maxTokens, thinking: o.thinking, last: o.messages[o.messages.length - 1].content });
      const [text, reason] = replies[Math.min(i++, replies.length - 1)];
      o.onMetrics?.({ model: 'f', promptTokens: 10, evalTokens: 5, finishReason: reason });
      return text;
    },
  };
}

async function main() {
  // config defaults
  vs.__resetConfig();
  ok(getConfig().maxOutputTokens === 4096 && getConfig().thinking === 'default', 'defaults: 4096 output tokens per reply, thinking = model default');
  vs.__setConfig({ 'forge.maxOutputTokens': 0, 'forge.thinking': 'off' });
  ok(getConfig().maxOutputTokens === 0 && getConfig().thinking === 'off', 'settings are read (0 = runtime default, thinking off)');
  vs.__setConfig({ 'forge.maxOutputTokens': -5, 'forge.thinking': 'garbage' });
  ok(getConfig().maxOutputTokens === 0 && getConfig().thinking === 'default', 'negative / garbled values degrade safely');
  vs.__resetConfig();

  // the limit and thinking mode are actually sent
  {
    const m = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen[0].maxTokens === 4096 && m.seen[0].thinking === undefined, 'the agent loop sends the configured output limit; thinking is left to the model by default');
    vs.__setConfig({ 'forge.maxOutputTokens': 0, 'forge.thinking': 'off' });
    const m2 = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m2), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m2.seen[0].maxTokens === undefined && m2.seen[0].thinking === false, 'maxOutputTokens=0 sends no limit; thinking=off is sent as thinking:false');
    vs.__resetConfig();
  }

  // a truncated reply is answered with "continue", then the run proceeds normally
  {
    const ws = workspace();
    const file = tracePathFor(ws.fsPath, 'trunc');
    const w = new TraceWriter(file, 'trunc');
    const m = scripted([
      ['The discounts module looks correct. Now let me verify my analysis: the subtotal should be 40 but the code computes', 'length'], // cut off mid-sentence
      [act('read_file', { path: 'a.txt' }), 'stop'],
      ['All done.', 'stop'],
    ]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m, w), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    await w.flush();
    ok(m.seen.length === 3, `the cut-off reply did NOT end the turn — the model was asked again (${m.seen.length} model calls)`);
    ok(/cut off by the output-length limit/.test(m.seen[1].last), 'the continuation request explains what happened and asks for an action');
    ok(ev.filter((e) => e.type === 'final').length === 1 && (ev.find((e) => e.type === 'final') as any).text === 'All done.', 'the final answer is the real one, not the truncated fragment');
    ok(ev.some((e) => e.type === 'tool_call' && e.tool === 'read_file'), 'and the action after the nudge was executed');
    const rec = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(rec[0].finishReason === 'length' && rec[0].note === 'truncated-reply-nudge', 'the trace records finishReason "length" and the nudge');
  }

  // bounded: a model that is ALWAYS cut off does not loop forever
  {
    const m = scripted([['blah blah', 'length']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen.length === 4 && ev.some((e) => e.type === 'final'), `after 3 continuation requests it stops (4 model calls) and reports what it has (${m.seen.length})`);
  }

  // a truncated reply that nonetheless contains a complete action is just executed
  {
    const m = scripted([[act('read_file', { path: 'a.txt' }), 'length'], ['ok', 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(ev.some((e) => e.type === 'tool_call') && m.seen.length === 2 && !/cut off/.test(m.seen[1].last), 'a complete action is executed even if the runtime flagged the reply as length-limited');
  }

  // Plan mode has no tools: a long plan is accepted as-is
  {
    const m = scripted([['A very long plan that was cut off…', 'length']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'plan it', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'plan' });
    ok(m.seen.length === 1 && ev.some((e) => e.type === 'final'), 'Plan mode does not nudge (no tools to continue with)');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 truncation tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 truncation tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_truncation.ts:', err); process.exit(1); });
