// ============================================================================
// Abrupt stops (owner report 2026-10-03): a no-tool reply that is empty, or whose last sentence promises an action it never took,
// must not end the turn. src/agent/toolProtocol.ts classifyStalledReply + the agentLoop nudge (cap 2, then the normal final path).
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyStalledReply, formatStalledReplyNudge } from '../../src/agent/toolProtocol';
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
  ok(classifyStalledReply('') === 'empty', 'empty reply -> empty');
  ok(classifyStalledReply('   \n ') === 'empty', 'whitespace-only reply -> empty');
  ok(classifyStalledReply('<|end|><|return|>') === 'empty', 'only leftover Harmony control tokens -> empty');
  ok(classifyStalledReply("The parser is fixed. Now I'll write the tests:") === 'announced', '"Now I\'ll write the tests:" -> announced');
  ok(classifyStalledReply('Let me check the config file.') === 'announced', '"Let me check…" -> announced');
  ok(classifyStalledReply("I'm going to run the test suite now.") === 'announced', '"I\'m going to run…" -> announced');
  ok(classifyStalledReply('Next, I will update cli.py to add the delete command.') === 'announced', '"Next, I will update…" -> announced');
  ok(classifyStalledReply("Let's run the tests.") === 'announced', '"Let\'s run the tests." -> announced');
  ok(classifyStalledReply('All 12 tests pass. The bug was an off-by-one in slice().') === undefined, 'a plain result is a real answer');
  ok(classifyStalledReply('Done — added `delete`. Let me know if you want a confirmation prompt.') === undefined, '"let me know…" closer is a real answer');
  ok(classifyStalledReply("I'll be happy to help further.") === undefined, '"I\'ll be happy…" closer is a real answer');
  ok(classifyStalledReply('Should I also update the README? I can do that next.') === undefined, 'promise not in the LAST sentence -> real answer');
  ok(classifyStalledReply('Which file do you want me to change?') === undefined, 'a question to the user is a legitimate stop');
  ok(classifyStalledReply("I'll write the tests first, then the code. The work is complete.") === undefined, 'promise earlier, completion last -> real answer');
  ok(classifyStalledReply('Here is the fix:\n```py\n# Let me check this\nx = 1\n```') === undefined, 'intent wording inside a code block is ignored');
  ok(/forge_action/.test(formatStalledReplyNudge('announced')) && /did not do it/.test(formatStalledReplyNudge('announced')), 'announced nudge asks for the action now');
  ok(/no visible answer/.test(formatStalledReplyNudge('empty')), 'empty nudge names the problem');
}

function deps(fakeOllama: any, events: AgentEvent[]) {
  const workspaceRoot = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stalled-')));
  return {
    ollama: fakeOllama,
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
  } as any;
}

async function run(replies: string[], mode = 'agent') {
  const events: AgentEvent[] = [];
  const seen: any[][] = [];
  let i = 0;
  const fake = { chat: async (req: any) => { seen.push(req.messages.map((x) => ({ ...x }))); return replies[Math.min(i++, replies.length - 1)]; } };
  await runAgentTurn([], 'add a delete command', deps(fake, events), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode } as any);
  const finals = events.filter((e: any) => e.type === 'final') as any[];
  return { calls: i, finals, seen, events };
}

async function testLoop() {
  const action = '```forge_action\n{"tool": "list_files", "args": {"path": "."}}\n```';
  let r = await run(["I've read the code. Now I'll list the files:", action, 'Listed the files; nothing else to do.']);
  ok(r.calls === 3, `announced action -> nudged, model then acts, then answers (calls=${r.calls}, want 3)`);
  ok(r.finals.length === 1 && /nothing else to do/.test(r.finals[0].text), 'the final answer is the real one, not the announcement');
  const nudged = r.seen[1].some((m: any) => m.role === 'user' && /did not do it/.test(m.content));
  ok(nudged, 'the second call saw the announced-action nudge');

  r = await run(['', 'All done, the command is added.']);
  ok(r.calls === 2 && r.finals.length === 1 && /All done/.test(r.finals[0].text), `empty reply -> nudged once, then real final (calls=${r.calls})`);

  r = await run(['', '', '']);
  ok(r.calls === 3, `always-empty model: 2 nudges then stop (calls=${r.calls}, want 3)`);
  ok(r.finals.length === 1 && /returned no answer/.test(r.finals[0].text), 'after the cap the user sees an explanation, not a blank final');
  ok(r.events.some((e: any) => e.type === 'done'), 'turn still ends with done');

  r = await run(["Let me check that.", "Let me check that.", "Let me check that."]);
  ok(r.calls === 3 && r.finals.length === 1, `announce-forever model: capped at 2 nudges then final (calls=${r.calls})`);

  r = await run(['Fixed. Let me know if you need more.']);
  ok(r.calls === 1 && r.finals.length === 1, 'a genuine answer ends the turn with no extra call');

  r = await run(["Now I'll outline the steps:"], 'plan');
  ok(r.calls === 1, 'plan mode never nudges (no tools there)');
}

(async () => {
  testClassifier();
  await testLoop();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
