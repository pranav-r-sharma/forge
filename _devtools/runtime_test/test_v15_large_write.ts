// Large write_file replies truncated at max_output_tokens (finishReason 'length') cannot complete in one shot;
// recovery must use smaller chunks + append, not resend the whole file.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { getConfig, resolveEffectiveMaxOutputTokens } from '../../src/util/config';
import { formatIncompleteActionNudge } from '../../src/agent/toolProtocol';
import { writeFileTool } from '../../src/tools/fileTools';
import { ToolExecContext } from '../../src/agent/types';
import { AgentEvent } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const vs: any = vscode;
const act = (tool: string, args: any) => '```forge_action\n' + JSON.stringify({ tool, args }) + '\n```';

function deps(root: vscode.Uri, ollama: any) {
  const l = new TaskLedger();
  const ev: AgentEvent[] = [];
  const pending = new PendingEditManager(root);
  return {
    ollama,
    pendingEdits: pending,
    approvalBroker: new ApprovalBroker((e: AgentEvent) => ev.push(e), () => [], () => false),
    hooks: new HookRunner(root),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    taskLedger: { addTasks: (t: any[]) => t.map((x) => l.add(typeof x === 'string' ? x : x.description).id), updateTask: () => true, list: () => l.list() },
    workspaceRoot: root,
    workspaceName: 't',
    events: ev,
    pending,
  } as any;
}

function scripted(replies: [string, string][]) {
  const seen: { maxTokens?: number; last: string }[] = [];
  let i = 0;
  return {
    seen,
    chat: async (o: any) => {
      seen.push({ maxTokens: o.maxTokens, last: o.messages[o.messages.length - 1].content });
      const [text, reason] = replies[Math.min(i++, replies.length - 1)];
      o.onMetrics?.({ model: 'f', promptTokens: 10, evalTokens: 5, finishReason: reason });
      return text;
    },
  };
}

function fileCtx(initial?: string) {
  const state = { text: initial as string | undefined };
  const ctx = {
    workspaceRoot: vscode.Uri.file('/ws'),
    cancellation: new vscode.CancellationTokenSource().token,
    proposeEdit: async (e: any) => { state.text = e.kind === 'delete' ? undefined : e.newText; return { id: 'e', applied: true }; },
    readEffective: async () => state.text,
  } as any as ToolExecContext;
  return { state, ctx };
}

const workspace = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-large-write-'));
  return vscode.Uri.file(d);
};

async function main() {
  vs.__resetConfig();
  ok(getConfig().maxOutputTokens === 0, 'default maxOutputTokens is 0 (auto)');
  ok(resolveEffectiveMaxOutputTokens(0, 32768) === 16384, 'auto cap = min(context/2, 32768), at least 8192');
  ok(resolveEffectiveMaxOutputTokens(0, 12000) === 8192, 'auto cap floors at 8192');
  ok(resolveEffectiveMaxOutputTokens(6000, 32768) === 6000, 'explicit user cap is respected');

  const partial =
    '```forge_action\n{"tool":"write_file","args":{"path":"src/big_module.py","content":"' + 'A'.repeat(200);
  const nudge = formatIncompleteActionNudge(partial, true);
  ok(/append/.test(nudge) && /Do NOT resend the entire file/.test(nudge) && /src\/big_module\.py/.test(nudge), 'length-truncated write_file nudge tells the model to use append, not resend the whole file');

  // Bug reproduction: model keeps getting cut off on the same whole-file write — never executes write_file.
  {
    const ws = workspace();
    const m = scripted([[partial, 'length'], [partial, 'length'], [partial, 'length'], [partial, 'length']]);
    const d = deps(ws, m);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', d, (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    const writes = ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file');
    ok(writes.length === 0, `repeated length-truncated whole-file attempts never run write_file (${writes.length} calls)`);
    ok(ev.some((e) => e.type === 'final'), 'run ends after incomplete-action cap');
    const fin = (ev.find((e) => e.type === 'final') as any)?.text ?? '';
    ok(/big_module\.py/.test(fin), 'cap failure names the stuck file');
  }

  // append:true stitches staged content across calls.
  {
    const { state, ctx } = fileCtx();
    let r1 = await writeFileTool({ path: 'big.py', content: 'line1\n' }, ctx);
    ok(r1.ok && state.text === 'line1\n', 'first chunk creates the file');
    let r2 = await writeFileTool({ path: 'big.py', content: 'line2\n', append: true }, ctx);
    ok(r2.ok && state.text === 'line1\nline2\n', 'append:true adds to existing staged content');
    let r3 = await writeFileTool({ path: 'big.py', content: 'line3\n', append: true }, ctx);
    ok(r3.ok && state.text === 'line1\nline2\nline3\n', 'multiple append calls accumulate');
  }

  // Agent loop: after a length cutoff, the model can finish via write_file + append.
  {
    const ws = workspace();
    const part1 = act('write_file', { path: 'src/big_module.py', content: 'part one\n' });
    const part2 = act('write_file', { path: 'src/big_module.py', content: 'part two\n', append: true });
    const m = scripted([[partial, 'length'], [part1, 'stop'], [part2, 'stop'], ['done', 'stop']]);
    const d = deps(ws, m);
    const ev: AgentEvent[] = [];
    await runAgentTurn([], 'go', d, (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
    const uri = vscode.Uri.joinPath(ws, 'src/big_module.py');
    const effective = await d.pending.readEffective(uri);
    ok(effective === 'part one\npart two\n', `multi-part write after truncation nudge produces full file (got ${JSON.stringify(effective)})`);
    ok(ev.filter((e) => e.type === 'tool_call' && e.tool === 'write_file').length === 2, 'two write_file steps (initial + append)');
  }

  // Auto output cap is always sent (never undefined / runtime 512 default).
  {
    vs.__resetConfig();
    const m = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto', numCtx: 32768 });
    ok(m.seen[0].maxTokens === 16384, `default auto sends derived max_tokens (${m.seen[0].maxTokens}), not undefined`);
    vs.__setConfig({ 'forge.maxOutputTokens': 12000 });
    const m2 = scripted([['done', 'stop']]);
    await runAgentTurn([], 'go', deps(workspace(), m2), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto', numCtx: 32768 });
    ok(m2.seen[0].maxTokens === 12000, 'explicit forge.maxOutputTokens overrides auto');
    vs.__resetConfig();
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 large-write tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 large-write tests passed.');
}

main().catch((err) => { console.error('Uncaught error in test_v15_large_write.ts:', err); process.exit(1); });
