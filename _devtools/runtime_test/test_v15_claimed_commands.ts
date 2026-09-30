import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from '../../src/ollama/types';
import {
  collectTurnToolFacts,
  commandMatchesTaskForm,
  commandWasExecuted,
  evaluateClaimedCommands,
  extractClaimedCommands,
  extractTaskCommandForms,
  finalAnswerMakesUniversalFileClaim,
  findPerFileCommandGaps,
  findUnexercisedTaskForms,
  findUnrunClaimedCommands,
  formatTaskCommandNudge,
  shouldSendTaskCommandNudge,
  taskCommandFormUnverifiedMarkers,
  unwrapShellWrapper,
  isPerFileVerificationTemplate,
  scriptOperandIsCheckTarget,
  templateHasOnlyFlagsAfterExecutable,
} from '../../src/agent/claimChecker';
import { detectNestedToolAction, formatNestedActionResend, unwrapNestedToolCall } from '../../src/tools/argErrors';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ---------- claimed commands in final answers ----------
{
  const cmds = extractClaimedCommands('Ran `python3 -m py_compile main.py` and `npm test`.');
  ok(cmds.includes('python3 -m py_compile main.py') && cmds.includes('npm test'), 'extractClaimedCommands finds shell-like backtick spans');
  ok(!extractClaimedCommands('See `src/foo.py` for details.').length, 'extractClaimedCommands ignores non-shell backticks');

  ok(commandWasExecuted('python3 -m py_compile', ['python3 -m py_compile tracker/models.py']), 'prefix match: py_compile template vs concrete run');
  ok(commandWasExecuted('python3 main.py demo', ['python3 main.py demo']), 'exact command match');

  const unrun = findUnrunClaimedCommands('I ran `python3 -m unittest` successfully.', ['python3 main.py demo']);
  ok(unrun.length === 1 && unrun[0] === 'python3 -m unittest', 'findUnrunClaimedCommands flags a cited command that never ran');

  ok(finalAnswerMakesUniversalFileClaim('All five files compile and run correctly.'), 'universal claim: five files');
  ok(!finalAnswerMakesUniversalFileClaim('main.py works; tracker modules compile.'), 'no universal claim without trigger words');

  const gaps = findPerFileCommandGaps(
    [
      'python3 -m py_compile tracker/models.py',
      'python3 -m py_compile tracker/storage.py',
      'python3 -m py_compile tracker/reports.py',
      'python3 -m py_compile tracker/cli.py',
    ],
    ['tracker/models.py', 'tracker/storage.py', 'tracker/reports.py', 'tracker/cli.py', 'main.py'],
  );
  ok(
    gaps.some((g) => g.uncovered.includes('main.py')),
    'per-file gap: main.py never got py_compile while siblings did',
  );

  const nodeGaps = findPerFileCommandGaps(['node --check src/a.js'], ['src/a.js', 'src/b.js']);
  ok(
    nodeGaps.some((g) => g.template === 'node --check' && g.uncovered.includes('src/b.js')),
    'per-file gap: node --check on one .js file flags sibling',
  );

  const gofmtGaps = findPerFileCommandGaps(
    ['gofmt -w pkg/a.go', 'gofmt -w pkg/b.go'],
    ['pkg/a.go', 'pkg/b.go', 'pkg/c.go'],
  );
  ok(
    gofmtGaps.some((g) => g.template === 'gofmt -w' && g.uncovered.includes('pkg/c.go')),
    'per-file gap: gofmt -w template covers same extension',
  );

  ok(!isPerFileVerificationTemplate('cat'), 'cat-only template is not a per-file check');
  ok(!isPerFileVerificationTemplate('python3 demo'), 'python3 + positional subcommand is not a per-file template');
  ok(!isPerFileVerificationTemplate('python3'), 'bare python3 is not a per-file template');
  ok(templateHasOnlyFlagsAfterExecutable('python3 -m py_compile'), 'py_compile via -m is a valid template');
  ok(!templateHasOnlyFlagsAfterExecutable('python3 main.py demo'), 'main.py demo leaves positional demo');
  ok(
    findPerFileCommandGaps(['cat foo.py', 'cat bar.py'], ['foo.py', 'bar.py', 'baz.py']).length === 0,
    'cat on files does not define per-file verification coverage',
  );

  const multiNode = findPerFileCommandGaps(['node --check a.js b.js'], ['a.js', 'b.js', 'c.js']);
  ok(
    multiNode.some((g) => g.uncovered.includes('c.js') && !g.uncovered.includes('a.js')),
    'node --check a.js b.js: only paths present in the command count as covered',
  );

  const sevenPy = ['main.py', 'a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py'];
  ok(
    findPerFileCommandGaps(['python3 main.py -h'], sevenPy).length === 0,
    'python3 main.py -h: running script with -h is not a per-file check',
  );
  ok(
    findPerFileCommandGaps(['python3 main.py demo'], sevenPy).length === 0,
    'python3 main.py demo: running script with args is not a per-file check',
  );
  ok(
    findPerFileCommandGaps(['node app.js --help'], ['app.js', 'a.js', 'b.js']).length === 0,
    'node app.js --help: running app is not a per-file check',
  );
  const pyCompileGap = findPerFileCommandGaps(['python3 -m py_compile a.py'], ['a.py', 'b.py']);
  ok(
    pyCompileGap.some((g) => g.uncovered.includes('b.py')),
    'python3 -m py_compile a.py: sibling .py still uncovered',
  );
  const nodeCheckGap = findPerFileCommandGaps(['node --check a.js'], ['a.js', 'b.js']);
  ok(
    nodeCheckGap.some((g) => g.template === 'node --check' && g.uncovered.includes('b.js')),
    'node --check a.js: sibling .js still uncovered',
  );
  const bashCheckGap = findPerFileCommandGaps(['bash -n a.sh'], ['a.sh', 'b.sh']);
  ok(
    bashCheckGap.some((g) => g.uncovered.includes('b.sh')),
    'bash -n a.sh: sibling .sh still uncovered',
  );
  ok(scriptOperandIsCheckTarget('python3 -u main.py'), 'python3 -u main.py script operand is a check target');
}

// ---------- t08 cycle 2/3 fixtures ----------
{
  const repoRoot = path.join(__dirname, '..', '..');
  for (const cycle of ['cycle2', 'cycle3'] as const) {
    const file = path.join(repoRoot, '_devtools', 'e2e', 'results', `t08-five-file-build-gptossq8-${cycle}.messages.json`);
    const messages = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatMessage[];
    const final = messages.filter((m) => m.role === 'assistant').pop()?.content ?? '';
    const { executedCommands, filesWritten } = collectTurnToolFacts(messages);
    const check = evaluateClaimedCommands(final, executedCommands, filesWritten);
    ok(
      check.perFileGaps.some((g) => g.uncovered.includes('main.py')),
      `t08 ${cycle}: per-file check names main.py`,
    );
    ok(check.unrunCommands.length === 0, `t08 ${cycle}: no falsely cited inline commands in final answer`);
  }

  const cycle3Path = path.join(repoRoot, '_devtools', 'e2e', 'results', 't08-five-file-build-gptossq8-cycle3.messages.json');
  const cycle3 = JSON.parse(fs.readFileSync(cycle3Path, 'utf8')) as ChatMessage[];
  const final3 = cycle3.filter((m) => m.role === 'assistant').pop()?.content ?? '';
  const facts3 = collectTurnToolFacts(cycle3);
  const msg3 = evaluateClaimedCommands(final3, facts3.executedCommands, facts3.filesWritten).nudgeMessage;
  ok(msg3.includes('main.py'), 'cycle-3 nudge names main.py');
  ok(msg3.includes('python3 -m py_compile'), 'cycle-3 nudge names the per-file command template');
}

// ---------- no nudge when everything ran ----------
{
  const executed = ['python3 -m py_compile a.py', 'python3 -m py_compile b.py'];
  const written = ['a.py', 'b.py'];
  const check = evaluateClaimedCommands('All two files compile — ran `python3 -m py_compile` on each.', executed, written);
  ok(check.unrunCommands.length === 0 && check.perFileGaps.length === 0, 'no issues when every same-ext file got the per-file command');
}

// ---------- B silent without universal wording ----------
{
  const check = evaluateClaimedCommands(
    'tracker/models.py compiles.',
    ['python3 -m py_compile tracker/models.py'],
    ['tracker/models.py', 'main.py'],
  );
  ok(check.perFileGaps.length === 0, 'per-file gaps not reported without universal claim wording');
}

// ---------- cap / markers ----------
{
  const check = evaluateClaimedCommands(
    'All five files compile. Ran `python3 -m py_compile` on each.',
    ['python3 -m py_compile tracker/a.py'],
    ['tracker/a.py', 'main.py'],
  );
  ok(check.unverifiedMarkers.some((m) => m.includes('main.py')), 'leftover markers list uncovered files for the final event');
}

// ---------- t09 cycle-2: task CLI forms must match token order ----------
{
  const repoRoot = path.join(__dirname, '..', '..');
  const cycle2Path = path.join(repoRoot, '_devtools', 'e2e', 'results', 't09-harder-build-gptossq8-cycle2.messages.json');
  const taskPath = path.join(repoRoot, '_devtools', 'e2e', 'tasks', 't09-harder-build', 'task.md');
  const messages = JSON.parse(fs.readFileSync(cycle2Path, 'utf8')) as ChatMessage[];
  const taskMd = fs.readFileSync(taskPath, 'utf8');
  const finalBeforeNudge =
    'All seven files compile and the CLI works as specified. The demo runs, showing overdue books and a return fee. A scripted sequence with a fresh `--db` file demonstrates adding a book/member, borrowing, returning late, checking overdue (none after return), and listing fees. No errors were encountered.';
  const { executedCommands, filesWritten } = collectTurnToolFacts(messages);
  const taskForms = extractTaskCommandForms(taskMd);
  const check = evaluateClaimedCommands(finalBeforeNudge, executedCommands, filesWritten, taskForms);
  ok(check.perFileGaps.length === 0, 't09 cycle-2 final text: no per-file py_compile-style false positives from main.py demo runs');
  ok(check.unexercisedTaskForms.length === 5, 't09 cycle-2: five CLI forms not run (demo, py_compile, add-book exercised)');
  ok(
    !check.nudgeMessage.includes('add-book') &&
      check.nudgeMessage.includes('add-member') &&
      check.nudgeMessage.includes('borrow') &&
      check.nudgeMessage.includes('return') &&
      check.nudgeMessage.includes('overdue') &&
      check.nudgeMessage.includes('fees') &&
      !check.nudgeMessage.includes('demo') &&
      !check.nudgeMessage.includes('py_compile'),
    't09 cycle-2 nudge names add-book, add-member, borrow, return, overdue, fees (not demo/py_compile)',
  );
  ok(
    !commandMatchesTaskForm(
      'python3 main.py add-book --db PATH --isbn ISBN --title TITLE --author AUTHOR',
      "python3 main.py --db testdb.json add-book --isbn 111 --title 'Test Book' --author 'Author A'",
    ),
    'task form matcher rejects --db before subcommand',
  );
  ok(commandMatchesTaskForm('python3 main.py demo', 'python3 main.py demo'), 'task form matcher: exact demo form');
}

// ---------- t08 cycle-3: task CLI forms matched in order ----------
{
  const repoRoot = path.join(__dirname, '..', '..');
  const taskPath = path.join(repoRoot, '_devtools', 'e2e', 'tasks', 't08-five-file-build', 'task.md');
  const cycle3Path = path.join(repoRoot, '_devtools', 'e2e', 'results', 't08-five-file-build-gptossq8-cycle3.messages.json');
  const taskMd = fs.readFileSync(taskPath, 'utf8');
  const messages = JSON.parse(fs.readFileSync(cycle3Path, 'utf8')) as ChatMessage[];
  const { executedCommands } = collectTurnToolFacts(messages);
  const taskForms = extractTaskCommandForms(taskMd);
  const unex = findUnexercisedTaskForms(taskForms, executedCommands);
  ok(unex.length === 0, `t08 cycle-3: all task command forms exercised: ${JSON.stringify(unex)}`);
  const taskOnly = evaluateClaimedCommands('', executedCommands, [], taskForms);
  ok(taskOnly.unexercisedTaskForms.length === 0 && taskOnly.nudgeMessage === '', 't08 cycle-3: no task-command nudge');
}

// ---------- task-form nudge policy + bash -lc ----------
{
  const all = [
    'python3 main.py add-book --db PATH --isbn ISBN --title TITLE --author AUTHOR',
    'python3 main.py add-member --db PATH --member-id ID --name NAME',
    'python3 main.py borrow --db PATH --member-id ID --isbn ISBN --date YYYY-MM-DD',
    'python3 main.py return --db PATH --isbn ISBN --date YYYY-MM-DD',
    'python3 main.py overdue --db PATH --date YYYY-MM-DD',
    'python3 main.py fees --db PATH',
  ];
  const afterTwo = all.slice(2);
  ok(shouldSendTaskCommandNudge(all, undefined, 0), 'first task-form nudge when forms remain');
  ok(!shouldSendTaskCommandNudge(all, all, 1), 'no re-nudge without progress');
  ok(shouldSendTaskCommandNudge(afterTwo, all, 1), 're-nudge when unexercised set shrank');
  ok(!shouldSendTaskCommandNudge(afterTwo, all, 3), 'no nudge after cap of 3');
  const markers = taskCommandFormUnverifiedMarkers(['python3 main.py demo', 'python3 main.py fees --db PATH']);
  ok(
    markers.every((m) => m.startsWith('task command form not run:')) && markers.some((m) => m.includes('demo')),
    'unverified markers name missing task forms',
  );
  const nudge = formatTaskCommandNudge(['python3 main.py borrow --db PATH --member-id ID --isbn ISBN --date YYYY-MM-DD']);
  ok(nudge.includes('borrow') && !nudge.includes('add-book'), 'task nudge lists only still-missing forms');
  ok(unwrapShellWrapper('bash -lc "python3 main.py demo"') === 'python3 main.py demo', 'unwrap bash -lc');
  ok(unwrapShellWrapper("sh -c 'python3 main.py fees --db x'") === 'python3 main.py fees --db x', 'unwrap sh -c');
  ok(
    findUnexercisedTaskForms(['python3 main.py demo'], ['bash -lc "python3 main.py demo"']).length === 0,
    'commands inside bash -lc count as exercised',
  );
}

// ---------- nested action in args ----------
{
  const nested = detectNestedToolAction({
    tool: 'run_command',
    args: { command: 'python3 -m py_compile main.py' },
  });
  ok(nested?.tool === 'run_command' && nested.args.command === 'python3 -m py_compile main.py', 'detectNestedToolAction finds inner action');
  const unwrapped = unwrapNestedToolCall({ tool: 'run_command', args: nested!.args as Record<string, unknown> });
  ok(unwrapped.tool === 'run_command' && unwrapped.args.command === 'python3 -m py_compile main.py', 'unwrapNestedToolCall runs inner tool');
  const msg = formatNestedActionResend('run_command', nested!);
  ok(
    msg === 'You nested a whole action inside "args". Resend as {"tool":"run_command","args":{"command":"python3 -m py_compile main.py"}}',
    'nested-action resend message',
  );
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
console.log('All claimed-command checker tests passed.');
