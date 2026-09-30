// verify-before-done (proposal 4) + pinned user compaction (proposal 5)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectAutoVerifyCommand,
  extractAcceptanceCheckCommand,
  formatVerifyFinalNote,
  resolveVerifyCommandForFinal,
} from '../../src/agent/verifyBeforeDone';
import { pinUserMessagesForCompaction } from '../../src/agent/pinnedUserCompaction';
import { buildPinnedCompactedView } from '../../src/agent/contextManager';
import { ChatMessage } from '../../src/ollama/types';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}
function testDetectOrder() {
  const root = path.join(os.tmpdir(), `forge-vbd-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  const deps = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined),
    readdir: (p: string) => fs.readdirSync(p),
    pathExecutable: () => false,
    pytestImportable: false,
  };
  fs.writeFileSync(path.join(root, 'check.sh'), '#!/bin/bash\ntrue\n');
  ok(detectAutoVerifyCommand(root, deps) === 'bash check.sh', 'check.sh wins first');

  const root2 = path.join(os.tmpdir(), `forge-vbd2-${Date.now()}`);
  fs.mkdirSync(path.join(root2, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'scripts', 'check.sh'), 'true');
  fs.writeFileSync(path.join(root2, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  ok(detectAutoVerifyCommand(root2, deps) === 'bash scripts/check.sh', 'scripts/check.sh before package.json');

  const root3 = path.join(os.tmpdir(), `forge-vbd3-${Date.now()}`);
  fs.mkdirSync(root3);
  fs.writeFileSync(path.join(root3, 'package.json'), JSON.stringify({ scripts: { test: 'echo no test specified' } }));
  fs.mkdirSync(path.join(root3, 'tests'));
  ok(detectAutoVerifyCommand(root3, deps) === "python3 -m unittest discover -s tests -p 'test_*.py'", 'unittest when npm test placeholder');

  const e2eT09 = path.resolve(__dirname, '../e2e/tasks/t09-harder-build');
  ok(detectAutoVerifyCommand(e2eT09, deps) === 'bash check.sh', 't09 auto: bash check.sh');
  const e2eT11 = path.resolve(__dirname, '../e2e/tasks/t11-checklist');
  ok(detectAutoVerifyCommand(e2eT11, deps) === 'bash check.sh', 't11 auto: bash check.sh');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
  fs.rmSync(root3, { recursive: true, force: true });
}

function testResolveModes() {
  const base = {
    mode: 'agent' as const,
    verifyBeforeDone: 'auto' as const,
    settingVerifyCommand: '',
    userMessage: 'fix it',
    workspaceRoot: '/tmp',
    turnWroteFiles: true,
    detectDeps: { exists: () => false, readdir: () => [], readFile: () => undefined },
  };
  ok(resolveVerifyCommandForFinal({ ...base, verifyBeforeDone: 'off' }) === undefined, 'off skips auto');
  ok(
    resolveVerifyCommandForFinal({ ...base, verifyBeforeDone: 'custom', settingVerifyCommand: 'make check' }) === 'make check',
    'custom uses setting command',
  );
  ok(
    resolveVerifyCommandForFinal({ ...base, turnWroteFiles: false }) === undefined,
    'read-only turn skips verify',
  );
  ok(
    resolveVerifyCommandForFinal({ ...base, mode: 'ask', turnWroteFiles: true }) === undefined,
    'ask mode skips verify',
  );
  const userWins = extractAcceptanceCheckCommand('Ship it. Run `bash check.sh` before you say done.');
  ok(userWins === 'bash check.sh', 'acceptance command extracted from user message');
  ok(
    resolveVerifyCommandForFinal({
      ...base,
      userMessage: 'Run `bash check.sh` when finished',
      detectDeps: { exists: () => true, readdir: () => ['package.json'], readFile: () => '{"scripts":{"test":"npm test"}}' },
    }) === 'bash check.sh',
    'user acceptance command wins over npm test detect',
  );
  ok(
    resolveVerifyCommandForFinal({ ...base, sessionVerifyCommand: 'echo session' }) === 'echo session',
    'per-chat session verify wins',
  );
}

function testCompactionPins() {
  const archival: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'original task' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'also add --db per subcommand' },
    { role: 'assistant', content: 'sure' },
    { role: 'user', content: 'third correction' },
    { role: 'assistant', content: 'y' },
  ];
  const pinned = pinUserMessagesForCompaction(archival, 1, 6, 40_000);
  ok(pinned.length === 3, 'three user messages pinned');
  ok(pinned[0].content === 'original task' && pinned[1].content.includes('--db'), 'order preserved');

  const view = buildPinnedCompactedView(archival, 6, 'SUM', 40_000);
  ok(view.some((m) => m.content === 'third correction'), 'compacted view includes latest user verbatim');

  const bigMid = 'm'.repeat(5000);
  const archival2: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: bigMid },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'recent' },
  ];
  const capped = pinUserMessagesForCompaction(archival2, 0, 5, 200);
  ok(capped[0].content === 'first', 'cap keeps first');
  ok(capped.some((m) => m.content === 'recent'), 'cap keeps recent');
  ok(capped.some((m) => m.content.includes('summarized')), 'cap summarizes middle');
}

function testVerifyFinalNote() {
  ok(formatVerifyFinalNote('npm test', true).includes('passed'), 'final note shows pass');
}

async function main() {
  testDetectOrder();
  testResolveModes();
  testCompactionPins();
  testVerifyFinalNote();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
