import * as fs from 'fs';
import * as path from 'path';
import { buildSystemPrompt } from '../../src/agent/systemPrompt';
import { buildPinnedCompactedView } from '../../src/agent/contextManager';
import { serializePromptMessages, isPromptPrefixExtension } from '../../src/agent/promptPrefix';
import {
  extractRequirementsFromUserMessage,
  updateRequirementsFromMessages,
  renderRequirementsChecklistForPrompt,
  findRequirementsGateGaps,
  findRequirementsNudgeGaps,
  stripRequirementsBlockFromContent,
  formatRequirementsGateNudge,
  extendRequirementsPromptView,
  isRequirementsChecklistPromptMessage,
  estimateChecklistPromptChars,
  isRealUserTurnContent,
  parseRequirementsSelfReport,
  classifyRequirementKind,
  declinedRequirementNotes,
} from '../../src/agent/requirements';
import { ChatMessage } from '../../src/ollama/types';

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

function testT09StyleExtraction() {
  const taskPath = path.join(__dirname, '../../_devtools/e2e/tasks/t09-harder-build/task.md');
  const taskMd = fs.readFileSync(taskPath, 'utf8');
  const state = extractRequirementsFromUserMessage(taskMd);
  console.log('\n--- t09 requirement items (' + state.items.length + ') ---');
  for (const it of state.items) {
    console.log(`  ${it.id}. [${it.kind}] ${it.text.slice(0, 110)}${it.text.length > 110 ? '…' : ''}`);
  }
  console.log('--- end t09 list ---\n');
  ok(state.items.length >= 6 && state.items.length <= 24, `t09 yields distinct requirements (${state.items.length}, cap 24)`);
  ok(
    state.items.some((it) => it.text.includes('inventory/cli.py') || it.text.includes('cli.py')),
    'extracts file-path requirements',
  );
  ok(state.items.some((it) => it.text.includes('python3 main.py')), 'extracts CLI command forms');
  const dupPaths = state.items.filter((it) => it.text.startsWith('Create or update file'));
  const bulletPaths = state.items.filter((it) => it.text.includes('inventory/') && !it.text.startsWith('Run command'));
  ok(dupPaths.length <= 2, `path dedupe avoids redundant Create-or-update lines (${dupPaths.length})`);
  ok(bulletPaths.length >= 5, 'keeps per-file bullet requirements from task');
  const rendered = renderRequirementsChecklistForPrompt(state);
  ok(rendered.includes('## Requirements'), 'renders checklist header');
  ok(rendered.includes('[?]') || rendered.includes('[ ]'), 'renders kind marks');
  ok(rendered.includes('Requirements:** section'), 'checklist includes self-report format hint');
  ok(estimateChecklistPromptChars(state) > 100, 'checklist has non-trivial size');
}

function testTrackingWriteAndCommand() {
  let state = extractRequirementsFromUserMessage(
    'Update `src/foo.py`. Run `python3 -m py_compile src/foo.py`.',
  );
  ok(state.items.every((it) => it.kind === 'checkable'), 'path and py_compile items are checkable');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: '```forge_action\n{"tool":"write_file","args":{"path":"src/foo.py","content":"x"}}\n```',
    },
    { role: 'user', content: '[Tool "write_file" result]\nok' },
    {
      role: 'assistant',
      content: '```forge_action\n{"tool":"run_command","args":{"command":"python3 -m py_compile src/foo.py"}}\n```',
    },
    { role: 'user', content: '[Tool "run_command" result]\n(exit code: 0)' },
  ];
  state = updateRequirementsFromMessages(state, messages);
  ok(state.items.every((it) => it.status === 'done'), 'write + successful command mark items done');
}

function testJudgmentSelfReportDone() {
  let state = extractRequirementsFromUserMessage(
    '1. Never use global mutable state in this module.\n' + 'Context: '.repeat(20),
  );
  ok(state.items[0]?.kind === 'judgment', 'vague policy line is judgment');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: 'Done.\n\nRequirements:\n1. done — only module-level constants, no globals\n',
    },
  ];
  state = updateRequirementsFromMessages(state, messages);
  ok(state.items[0]?.status === 'done', 'judgment item satisfied by Requirements: done line');
  ok(findRequirementsGateGaps(state).length === 0, 'no gate gaps after judgment report');
}

function testJudgmentNotDoneNoNudge() {
  let state = extractRequirementsFromUserMessage('1. Keep every function under 40 lines.');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: 'Requirements:\n1. not done — several helpers exceed 40 lines in cli.py\n',
    },
  ];
  state = updateRequirementsFromMessages(state, messages);
  ok(state.items[0]?.status === 'declined', 'honest not done sets declined');
  ok(findRequirementsGateGaps(state).length === 0, 'declined judgment is not a gate gap');
  ok(declinedRequirementNotes(state).length === 1, 'declined surfaced for final note');
}

function testCheckableIgnoresSelfReport() {
  let state = extractRequirementsFromUserMessage('Run `python3 -m py_compile src/foo.py`.');
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    {
      role: 'assistant',
      content: 'Requirements:\n1. done — compiled mentally\n',
    },
  ];
  state = updateRequirementsFromMessages(state, messages);
  ok(state.items[0]?.status === 'open', 'checkable still open without tool evidence');
  ok(findRequirementsGateGaps(state).length === 1, 'checkable still blocks gate');
}

function testNoNudgeWhenAllAddressed() {
  let state = extractRequirementsFromUserMessage(
    '1. Document the API in README.\n2. Run `python3 -m py_compile main.py`.',
  );
  const messages: ChatMessage[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'Requirements:\n1. done — added API section to README\n' },
    {
      role: 'assistant',
      content: '```forge_action\n{"tool":"run_command","args":{"command":"python3 -m py_compile main.py"}}\n```',
    },
    { role: 'user', content: '[Tool "run_command" result]\n(exit code: 0)' },
  ];
  state = updateRequirementsFromMessages(state, messages);
  ok(findRequirementsGateGaps(state).length === 0, 'mixed judgment + checkable all satisfied');
}

function testParseSelfReportTolerant() {
  const lines = parseRequirementsSelfReport(
    'Summary\n\nRequirements:\n1. done — wired CLI\n2. not done — no time for docs\n3. met — tests pass\n',
  );
  ok(lines.length === 3, 'parses three requirement lines');
  ok(lines[0].verdict === 'done' && lines[1].verdict === 'not_done', 'done vs not done');
  const bold = parseRequirementsSelfReport('**Requirements**\n\n5. done — stdlib only\n');
  ok(bold.length === 1 && bold[0].id === 5, 'parses markdown-bold Requirements header');
}

function testGateNudgeAndCap() {
  const state = extractRequirementsFromUserMessage('Run `python3 -m py_compile main.py`. Never skip lint.');
  const gaps = findRequirementsNudgeGaps(state);
  ok(gaps.length === 1 && gaps[0].kind === 'checkable', 'only checkable open items nudge');
  const nudge = formatRequirementsGateNudge(gaps);
  ok(nudge.includes('[System check]') && nudge.includes('Requirements:'), 'gate nudge lists missing items and format');
  ok(classifyRequirementKind('Run command form: `python3 main.py demo`.') === 'checkable', 'command forms checkable');
}

function testCompactChecklist() {
  let state = extractRequirementsFromUserMessage('1. Do A.\n2. Run `python3 main.py`.');
  state = updateRequirementsFromMessages(state, [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '```forge_action\n{"tool":"run_command","args":{"command":"python3 main.py"}}\n```' },
    { role: 'user', content: '[Tool "run_command" result]\n(exit code: 0)' },
  ]);
  const rendered = renderRequirementsChecklistForPrompt(state);
  ok(rendered.includes('1 requirement(s) done'), 'done items collapse to a one-line count');
  ok(!rendered.includes('[x] 2.'), 'done items are not listed in full');
}

function legacyInjectChecklistOnLastUser(view: ChatMessage[], checklistBlock: string): ChatMessage[] {
  if (!checklistBlock) return view;
  const copy = view.map((m) => ({ ...m }));
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'user') {
      const base = stripRequirementsBlockFromContent(copy[i].content);
      copy[i] = { ...copy[i], content: base ? `${base}\n\n${checklistBlock}` : checklistBlock };
      return copy;
    }
  }
  return copy;
}

function testPrefixStability() {
  const sys = buildSystemPrompt('w', 'agent');
  const state = extractRequirementsFromUserMessage('1. Do thing A.\n2. Do thing B.');
  const checklist = renderRequirementsChecklistForPrompt(state);
  const view1: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: 'work' },
    { role: 'assistant', content: 'step1' },
    { role: 'user', content: '[Tool "read_file" result]\ndata' },
  ];
  const step1 = extendRequirementsPromptView(undefined, view1, checklist);
  ok(view1[0].content === step1[0].content, 'system message byte-identical when checklist injected');
  ok(view1[1].content === step1[1].content, 'earlier user messages never edited');
  ok(isRequirementsChecklistPromptMessage(step1[step1.length - 1].content), 'checklist is its own trailing user message');
  const view3: ChatMessage[] = [
    ...view1,
    { role: 'assistant', content: 'step2' },
    { role: 'user', content: '[Tool "write_file" result]\nok' },
  ];
  const state2 = updateRequirementsFromMessages(state, view3);
  const checklist2 = renderRequirementsChecklistForPrompt(state2);
  const step2 = extendRequirementsPromptView(step1, view3, checklist2);
  ok(isPromptPrefixExtension(step1, step2), 'extendRequirementsPromptView: step N is a byte prefix of step N+1');
  const legacy1 = legacyInjectChecklistOnLastUser(view1, checklist);
  const legacy2 = legacyInjectChecklistOnLastUser(view3, checklist2);
  ok(!isPromptPrefixExtension(legacy1, legacy2), 'legacy last-user inject: prior send is not a prefix of next send');
  ok(legacy1[3].content.includes('## Requirements (track each)'), 'legacy send embeds checklist in tool-result user message');
  ok(!legacy2[3].content.includes('## Requirements (track each)'), 'next send drops checklist from that same message index');
}

function testReplayReqAb2T11Prefix() {
  const p = path.join(__dirname, '../e2e/results/req-ab2-t11-checklist-req-on-r1.messages.json');
  if (!fs.existsSync(p)) {
    console.log('  (skip replay — req-ab2 t11 messages not present)');
    return;
  }
  const msgs = JSON.parse(fs.readFileSync(p, 'utf8')) as ChatMessage[];
  const userTask = msgs.find((m) => m.role === 'user' && !m.content.startsWith('[Tool'))?.content ?? '';
  let state = extractRequirementsFromUserMessage(userTask);
  let prevView: ChatMessage[] | undefined;
  let modelCall = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'assistant') continue;
    const archival = msgs.slice(0, i);
    state = updateRequirementsFromMessages(state, msgs.slice(0, i));
    const checklist = renderRequirementsChecklistForPrompt(state);
    const view = extendRequirementsPromptView(prevView, archival, checklist);
    if (prevView) {
      ok(isPromptPrefixExtension(prevView, view), `req-ab2 t11 replay model call ${modelCall}: prefix extension`);
    }
    prevView = view;
    modelCall++;
  }
  ok(modelCall > 5, 'req-ab2 t11 replay exercised multiple model calls');
}

function testCompactionPinsFollowUpUser() {
  const archival: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original task' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'actually use --db on each subcommand' },
    { role: 'assistant', content: 'sure' },
    { role: 'user', content: '[Tool "read_file" result]\nfile' },
  ];
  const view = buildPinnedCompactedView(archival, 5, 'SUM');
  ok(view.some((m) => m.content === 'original task'), 'first user message pinned');
  ok(view.some((m) => m.content.includes('actually use --db')), 'follow-up user correction pinned');
  ok(isRealUserTurnContent('fix the bug') && !isRealUserTurnContent('[Tool "read_file" result]'), 'real user turn detection');
}

async function main() {
  testT09StyleExtraction();
  testTrackingWriteAndCommand();
  testJudgmentSelfReportDone();
  testJudgmentNotDoneNoNudge();
  testCheckableIgnoresSelfReport();
  testNoNudgeWhenAllAddressed();
  testParseSelfReportTolerant();
  testGateNudgeAndCap();
  testCompactChecklist();
  testPrefixStability();
  testReplayReqAb2T11Prefix();
  testCompactionPinsFollowUpUser();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
