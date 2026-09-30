import * as fs from 'fs';
import * as path from 'path';
import { buildSystemPrompt } from '../../src/agent/systemPrompt';
import { buildPinnedCompactedView } from '../../src/agent/contextManager';
import { serializePromptMessages, sharedPrefixLength } from '../../src/agent/promptPrefix';
import {
  extractRequirementsFromUserMessage,
  updateRequirementsFromMessages,
  renderRequirementsChecklistForPrompt,
  findRequirementsGateGaps,
  formatRequirementsGateNudge,
  injectRequirementsIntoPromptView,
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
}

function testGateNudgeAndCap() {
  const state = extractRequirementsFromUserMessage('1. Must add tests.\n2. Never skip lint.');
  const gaps = findRequirementsGateGaps(state);
  ok(gaps.length === 2, 'open items block gate');
  const nudge = formatRequirementsGateNudge(gaps);
  ok(nudge.includes('[System check]') && nudge.includes('Requirements:'), 'gate nudge lists missing items and format');
  ok(classifyRequirementKind('Run command form: `python3 main.py demo`.') === 'checkable', 'command forms checkable');
}

function testPrefixStability() {
  const sys = buildSystemPrompt('w', 'agent');
  const sys2 = buildSystemPrompt('w', 'agent', { terse: true });
  ok(sys !== sys2, 'system prompt may change with options');
  const state = extractRequirementsFromUserMessage('1. Do thing A.\n2. Do thing B.');
  const checklist = renderRequirementsChecklistForPrompt(state);
  const view1: ChatMessage[] = [
    { role: 'system', content: sys },
    { role: 'user', content: 'work' },
    { role: 'assistant', content: 'step1' },
    { role: 'user', content: '[Tool "read_file" result]\ndata' },
  ];
  const view2 = injectRequirementsIntoPromptView(view1, checklist);
  const sp1 = sharedPrefixLength(serializePromptMessages(view1), serializePromptMessages(view2));
  ok(sp1 === serializePromptMessages(view1).length - view1[view1.length - 1].content.length, 'checklist only changes the last message prefix');
  ok(view1[0].content === view2[0].content, 'system message byte-identical when checklist injected');
  const view3 = injectRequirementsIntoPromptView(view2, checklist + '\n[x] 1. done');
  ok(view1[0].content === view3[0].content, 'two checklist steps keep same system prefix');
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
  testPrefixStability();
  testCompactionPinsFollowUpUser();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
