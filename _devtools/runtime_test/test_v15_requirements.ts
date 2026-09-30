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
  ok(state.items.length >= 8, `t09-style task yields many requirements (${state.items.length})`);
  ok(
    state.items.some((it) => it.text.includes('inventory/cli.py') || it.text.includes('cli.py')),
    'extracts file-path requirements',
  );
  ok(state.items.some((it) => it.text.includes('python3 main.py')), 'extracts CLI command forms');
  const rendered = renderRequirementsChecklistForPrompt(state);
  ok(rendered.includes('## Requirements'), 'renders checklist header');
  ok(estimateChecklistPromptChars(state) > 100, 'checklist has non-trivial size');
}

function testTrackingWriteAndCommand() {
  let state = extractRequirementsFromUserMessage(
    'Update `src/foo.py`. Run `python3 -m py_compile src/foo.py`.',
  );
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

function testGateNudgeAndCap() {
  const state = extractRequirementsFromUserMessage('1. Must add tests.\n2. Never skip lint.');
  const gaps = findRequirementsGateGaps(state);
  ok(gaps.length === 2, 'open items block gate');
  const nudge = formatRequirementsGateNudge(gaps);
  ok(nudge.includes('[System check]') && nudge.includes('1.'), 'gate nudge lists missing items');
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
