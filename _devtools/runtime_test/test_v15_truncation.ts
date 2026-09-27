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
  ok(getConfig().maxOutputTokens === 4096 && getConfig().thinking === 'auto', "defaults: 4096 output tokens per reply, thinking = 'auto' (fast until stuck)");
  vs.__setConfig({ 'forge.maxOutputTokens': 0, 'forge.thinking': 'off' });
  ok(getConfig().maxOutputTokens === 0 && getConfig().thinking === 'off', 'settings are read (0 = runtime default, thinking off)');
  vs.__setConfig({ 'forge.maxOutputTokens': -5, 'forge.thinking': 'garbage' });
  ok(getConfig().maxOutputTokens === 0 && getConfig().thinking === 'auto', 'negative / garbled values degrade safely');
  vs.__resetConfig();

  // the limit and thinking mode are actually sent
  {
    const m = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen[0].maxTokens === 4096 && m.seen[0].thinking === false, "the agent loop sends the configured output limit; with the default 'auto', thinking starts OFF (fast)");
    vs.__setConfig({ 'forge.maxOutputTokens': 0, 'forge.thinking': 'off' });
    const m2 = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m2), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m2.seen[0].maxTokens === undefined && m2.seen[0].thinking === false, 'maxOutputTokens=0 sends no limit; thinking=off is sent as thinking:false');
    vs.__resetConfig();
  }

  // length-truncated mid-write_file: nudge names the path (not generic "next action")
  {
    const partial = '```forge_action\n{"tool":"write_file","args":{"path":"src/discounts.py","content":"def apply(';
    const m = scripted([[partial, 'length'], ['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(/src\/discounts\.py/.test(m.seen[1].last) && /Finish that exact action on `src\/discounts\.py`/.test(m.seen[1].last), 'the length-truncation nudge names the exact file that was left unfinished');
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

  // an abandoned action (a "tool":"..." fragment that never closes, finishReason "stop" not "length" -
  // the t07-build-from-scratch acceptance-test finding) is ALSO not accepted as a final answer
  {
    const ws = workspace();
    const file = tracePathFor(ws.fsPath, 'abandoned');
    const w = new TraceWriter(file, 'abandoned');
    const abandoned = '```forge_action\n{"tool":"write_file","args":{"path":"contacts/storage.py","content":"import json\\nclass ContactBook:\\n    def add(self';
    const m = scripted([
      [abandoned, 'stop'], // the model's own stop token, mid-JSON - NOT a length cutoff
      [act('read_file', { path: 'a.txt' }), 'stop'],
      ['All done.', 'stop'],
    ]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m, w), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    await w.flush();
    ok(m.seen.length === 3, `the abandoned action did NOT end the turn — the model was asked again (${m.seen.length} model calls)`);
    ok(/contacts\/storage\.py/.test(m.seen[1].last) && /Finish that exact action on `contacts\/storage\.py`/.test(m.seen[1].last), 'the abandoned-action nudge names the exact file that was left unfinished');
    ok(ev.filter((e) => e.type === 'final').length === 1 && (ev.find((e) => e.type === 'final') as any).text === 'All done.', 'the final answer is the real one, not the abandoned JSON fragment');
    const rec = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok(rec[0].finishReason === 'stop' && rec[0].note === 'abandoned-action-nudge', 'the trace records finishReason "stop" and the abandoned-action nudge (distinct from the length-cutoff nudge)');
  }

  // a genuine final answer that happens to contain valid, non-tool JSON (no "tool" key) is NOT mistaken for an abandoned action
  {
    const m = scripted([['Here is the record shape:\n```json\n{"id": 1, "name": "Alice"}\n```', 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen.length === 1 && ev.some((e) => e.type === 'final'), 'a valid non-tool JSON example in a final answer is accepted immediately, no nudge');
  }

  // bounded: a model that is ALWAYS cut off does not loop forever
  {
    const m = scripted([['blah blah', 'length']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen.length === 4 && ev.some((e) => e.type === 'final'), `after 3 continuation requests it stops (4 model calls) and reports what it has (${m.seen.length})`);
  }

  // bounded: a model that ALWAYS abandons its action mid-JSON does not loop forever either (shares the same cap)
  {
    const abandoned = '```forge_action\n{"tool":"write_file","args":{"path":"x.py","content":"start of file';
    const m = scripted([[abandoned, 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(workspace(), m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(m.seen.length === 4 && ev.some((e) => e.type === 'final'), `after 3 continuation requests it stops (4 model calls) even for a repeatedly-abandoned action (${m.seen.length})`);
    const fin = (ev.find((e) => e.type === 'final') as any)?.text ?? '';
    ok(/stopped: could not produce a valid action for write_file on x\.py after 3 attempts/.test(fin), 'incomplete-action cap ends with an explicit failure note, not a silent success');
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

  // strict-catch: after an incomplete write_file nudge, the matching path is executed; pending clears
  {
    const ws = workspace();
    const abandoned = '```forge_action\n{"tool":"write_file","args":{"path":"contacts/storage.py","content":"class X';
    const finish = act('write_file', { path: 'contacts/storage.py', content: 'class X:\n  pass\n' });
    const m = scripted([[abandoned, 'stop'], [finish, 'stop'], ['done', 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file').length === 1, 'pending target: finishing the named path runs write_file once');
  }

  // strict-catch: a different write path is redirected once, then allowed on the second try
  {
    const ws = workspace();
    const abandoned = '```forge_action\n{"tool":"write_file","args":{"path":"target.py","content":"start';
    const wrong = act('write_file', { path: 'other.py', content: 'nope' });
    const m = scripted([[abandoned, 'stop'], [wrong, 'stop'], [wrong, 'stop'], ['done', 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(/Not executed.*target\.py/.test(m.seen[2].last), 'pending target: first wrong write gets a redirect naming the pending path');
    ok(ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file').length === 1, 'pending target: after one redirect the wrong write is allowed through');
  }

  // strict-catch: pending clears on any non-bypass tool targeting the same path (not only the same tool name)
  {
    const ws = workspace();
    const abandoned = '```forge_action\n{"tool":"edit_file","args":{"path":"contacts/storage.py","content":"class X';
    const finish = act('write_file', { path: 'contacts/storage.py', content: 'class X:\n  pass\n' });
    const m = scripted([[abandoned, 'stop'], [finish, 'stop'], ['done', 'stop']]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(!/Not executed/.test(m.seen[1].last), 'pending target: write_file on the pending path is not redirected when the abandoned tool name differed');
    ok(ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file').length === 1, 'pending target: same-path write_file runs once after a differently named abandoned action');
  }

  // strict-catch: read-only tools pass through while pending is still outstanding
  {
    const ws = workspace();
    const abandoned = '```forge_action\n{"tool":"write_file","args":{"path":"target.py","content":"start';
    const m = scripted([
      [abandoned, 'stop'],
      [act('read_file', { path: 'a.txt' }), 'stop'],
      [act('write_file', { path: 'target.py', content: 'ok\n' }), 'stop'],
      ['done', 'stop'],
    ]);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', deps(ws, m), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    ok(ev.some((e) => e.type === 'tool_call' && e.tool === 'read_file'), 'pending target: read_file is allowed before finishing the pending write');
    ok(!/Not executed/.test(m.seen[2].last), 'pending target: read_file does not trigger a redirect');
    ok(ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file').length === 1, 'pending target: the named write still runs afterward');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 truncation tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 truncation tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_truncation.ts:', err); process.exit(1); });
