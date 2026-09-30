// Runtime tests for this round's additions: Outcome mode's verify-gated
// "definition of done" loop in agentLoop.ts, runVerifyCommand, multi-model
// routing resolution, and the automatic memory-review fact parser.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { runVerifyCommand } from '../../src/agent/verifyCheck';
import { modeSupportsVerifyCommand } from '../../src/agent/modes';
import { resolveModelForMode } from '../../src/util/config';
import { parseFactsArray } from '../../src/forge/memoryReview';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';

const vs = vscode as any;

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

async function main() {
  // ---------- modeSupportsVerifyCommand ----------
  ok(modeSupportsVerifyCommand('agent') === true, 'Agent mode supports a definition-of-done command');
  ok(modeSupportsVerifyCommand('auto') === true, 'Auto mode supports a definition-of-done command');
  ok(modeSupportsVerifyCommand('outcome') === true, 'Outcome mode supports a definition-of-done command');
  ok(modeSupportsVerifyCommand('ask') === false, 'Ask mode (read-only, no actions) does not support a definition-of-done command');
  ok(modeSupportsVerifyCommand('plan') === false, 'Plan mode (no tools at all) does not support a definition-of-done command');

  // ---------- resolveModelForMode ----------
  const baseCfg = { chatModel: 'default-model', modelRouting: { plan: 'reasoning-model' } } as any;
  ok(resolveModelForMode('agent', '', baseCfg) === 'default-model', 'falls back to chatModel when no routing and no session override');
  ok(resolveModelForMode('plan', '', baseCfg) === 'reasoning-model', 'per-mode routing wins over the global chatModel');
  ok(resolveModelForMode('plan', 'session-override-model', baseCfg) === 'session-override-model', 'an explicit per-session model override wins over per-mode routing');

  // ---------- parseFactsArray ----------
  ok(JSON.stringify(parseFactsArray('["a", "b"]')) === JSON.stringify(['a', 'b']), 'parses a clean JSON array');
  ok(JSON.stringify(parseFactsArray('Sure, here you go: ["uses pnpm"] — hope that helps!')) === JSON.stringify(['uses pnpm']), 'extracts the array even when the model wraps it in prose');
  ok(JSON.stringify(parseFactsArray('[]')) === '[]', 'an empty array parses to an empty array (nothing worth remembering)');
  ok(JSON.stringify(parseFactsArray('not json at all')) === '[]', 'garbage input fails closed to an empty array rather than throwing');
  ok(JSON.stringify(parseFactsArray('["ok", 5, "  trimmed  ", ""]')) === JSON.stringify(['ok', 'trimmed']), 'non-string and blank entries are dropped, real entries are trimmed');

  // ---------- runVerifyCommand ----------
  const projRoot = path.resolve(__dirname, 'fixtures/proj');
  const fakeToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
  const passResult = await runVerifyCommand('node -e "process.exit(0)"', projRoot, fakeToken);
  ok(passResult.ok === true, 'runVerifyCommand reports ok=true for an exit-0 command');
  const failResult = await runVerifyCommand('node -e "process.exit(1)"', projRoot, fakeToken);
  ok(failResult.ok === false, 'runVerifyCommand reports ok=false for a non-zero exit');
  ok(failResult.output.includes('exit code: 1'), 'runVerifyCommand output includes the exit code for diagnosis');

  // ---------- agentLoop: the actual "definition of done" iterate-until-true loop ----------
  vs.__resetConfig();
  vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20 });

  const markerPath = path.join(projRoot, 'verify_marker.txt');
  try { fs.unlinkSync(markerPath); } catch { /* fine if it doesn't exist yet */ }

  let chatCalls = 0;
  const fakeOllama = {
    chat: async () => {
      chatCalls++;
      if (chatCalls === 1) return 'I believe this is done.';
      // Simulate the model's second attempt actually doing the work that
      // satisfies the goal — the test controls this directly rather than
      // going through a real write_file tool call, to isolate exactly the
      // verify-gate behavior in agentLoop.ts from tool execution.
      fs.writeFileSync(markerPath, 'done');
      return 'Now it is actually done.';
    },
  } as any;

  const events: AgentEvent[] = [];
  const workspaceRootUri = vscode.Uri.file(projRoot);
  const deps = {
    ollama: fakeOllama,
    pendingEdits: new PendingEditManager(workspaceRootUri),
    approvalBroker: new ApprovalBroker((e) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRootUri),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false, reason: 'not used in this test' }),
    chatMemorySearch: async () => [],
    workspaceRoot: workspaceRootUri,
    workspaceName: 'test',
  };

  const cts = new vscode.CancellationTokenSource();
  const result = await runAgentTurn(
    [],
    'Make the marker file exist.',
    deps as any,
    (e) => events.push(e),
    cts.token,
    'fake-model',
    { mode: 'outcome', verifyCommand: `node -e "process.exit(require('fs').existsSync('${markerPath.replace(/\\/g, '\\\\')}') ? 0 : 1)"` }
  );

  ok(chatCalls === 2, 'the model gets a second attempt after the first "done" claim fails the definition-of-done check');
  const verifyResults = events.filter((e): e is Extract<AgentEvent, { type: 'verify_result' }> => e.type === 'verify_result');
  ok(verifyResults.length === 2, 'two verify checks ran — one per attempt');
  ok(verifyResults[0].ok === false && verifyResults[1].ok === true, 'the first check fails (marker missing), the second passes (marker now exists)');
  const finalEvent = events.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final');
  ok(
    !!finalEvent && finalEvent.text.startsWith('Now it is actually done.') && finalEvent.verifyOk === true,
    'the turn only actually ends once the definition-of-done check genuinely passes, not on the first unverified claim',
  );
  ok(result.messages.some((m) => m.content.includes('Definition-of-done check failed')), 'the failed check is fed back into the model-facing transcript as real evidence, not silently retried');

  fs.unlinkSync(markerPath);

  // ---------- agentLoop: a verify command that never passes trips the loop detector rather than burning the whole iteration budget ----------
  let chatCalls2 = 0;
  const stuckOllama = {
    chat: async () => {
      chatCalls2++;
      return 'Still working on it.';
    },
  } as any;
  const events2: AgentEvent[] = [];
  const deps2 = { ...deps, ollama: stuckOllama };
  const cts2 = new vscode.CancellationTokenSource();
  await runAgentTurn(
    [],
    'Do something that will never actually succeed.',
    deps2 as any,
    (e) => events2.push(e),
    cts2.token,
    'fake-model',
    { mode: 'outcome', verifyCommand: 'node -e "process.exit(1)"' }
  );
  const loopFinal = events2.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final' && /loop/i.test(e.text));
  ok(!!loopFinal, 'an always-failing definition-of-done check trips the loop detector with a clear message instead of exhausting the whole iteration budget silently');
  ok(chatCalls2 < 20, `the loop detector stopped this well short of the 20-iteration cap (stopped after ${chatCalls2} model calls)`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.4.x runtime tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
