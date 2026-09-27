// Unknown tool arg notes + loop-warning-before-stop (bridge task 2026-09-27).
import {
  argNameSimilarity,
  formatUnknownArgNotes,
  suggestClosestArgName,
} from '../../src/tools/unknownToolArgs';
import {
  formatLoopWarningMessage,
  LoopDetector,
  signatureForStep,
} from '../../src/agent/loopDetector';
import { checkLoop } from '../../src/agent/agentLoop';
import * as vs from '../stubs/vscode';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

// ---------- unknown args ----------
{
  ok(argNameSimilarity('line_start', 'start_line') >= 40, 'line_start is similar to start_line');
  ok(suggestClosestArgName('line_start', ['path', 'start_line', 'end_line']) === 'start_line', 'did-you-mean picks start_line for line_start');
  ok(suggestClosestArgName('cmd', ['command', 'cwd', 'background']) === 'command', 'did-you-mean prefers prefix cmd->command over cwd');
  ok(suggestClosestArgName('cmd', ['command', 'cwd', 'background']) !== 'cwd', 'cmd is not suggested as cwd');

  const note = formatUnknownArgNotes('read_file', { path: 'a.py', line_start: 1, line_end: 10 }, [
    'path',
    'start_line',
    'end_line',
  ]);
  ok(note.includes('line_start') && note.includes('start_line'), 'unknown line_start suggests start_line');
  ok(note.includes('line_end') && note.includes('end_line'), 'unknown line_end suggests end_line');
  ok(!note.includes('path'), 'known arg path is not mentioned');

  const noSuggest = formatUnknownArgNotes('read_file', { path: 'a.py', xyzzy: 1 }, ['path', 'start_line', 'end_line']);
  ok(noSuggest.includes('valid args:') && noSuggest.includes('xyzzy'), 'unrelated unknown arg lists valid args without a bogus suggestion');
}

// ---------- loop warn once ----------
{
  vs.__resetConfig();
  const detector = new LoopDetector();
  const events: any[] = [];
  const warnings: string[] = [];
  const traceNotes: string[] = [];
  const emit = (e: any) => events.push(e);
  const hooks = {
    pushLoopWarning: (m: string) => warnings.push(m),
    traceNote: (n: string) => traceNotes.push(n),
    unresolvedRunFailure: {
      command: 'python3 demo',
      exitCode: 1,
      filesEditedAfter: [],
      outputSnippet: 'SyntaxError: invalid syntax',
    },
  };

  let stopped = false;
  for (let i = 0; i < 6 && !stopped; i++) {
    stopped = checkLoop(
      detector,
      'read_file',
      { path: 'inventory/cli.py' },
      true,
      'No changes — already matches.',
      emit,
      hooks
    );
  }
  ok(warnings.length === 1, 'exactly one loop warning before hard stop');
  ok(traceNotes.includes('loop-warning'), 'loop-warning trace note recorded');
  ok(warnings[0].includes('read_file') && warnings[0].includes('inventory/cli.py'), 'warning names tool and path');
  ok(warnings[0].includes('No changes'), 'warning includes first line of last result');
  ok(warnings[0].includes('python3 demo') && warnings[0].includes('SyntaxError'), 'warning includes failing command context');
  ok(stopped === true, 'hard stop after the warning is ignored');
  ok(events.some((e) => e.type === 'error' && /loop/i.test(e.message)), 'loop error still emitted on second trip');
  vs.__resetConfig();
}

{
  const msg = formatLoopWarningMessage('write_file', { path: 'x.ts' }, 3, 'Error: search string not found', undefined);
  ok(msg.startsWith('[System check]') && msg.includes('write_file') && msg.includes('x.ts'), 'formatLoopWarningMessage baseline');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
