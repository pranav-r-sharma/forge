// Runtime tests for the 0.7.0 round: isAutonomousMode() (the Outcome-mode
// approval-gate fix), spawn_subagent's recursive runAgentTurn behavior and
// its nesting-depth cap, per-turn numCtx override, the "brief status
// messages" AgentEvent stream, ChatStore.rename(), and hwMetrics.getRamStatus().
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { isAutonomousMode } from '../../src/agent/modes';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { ChatStore } from '../../src/forge/chatStore';
import { getRamStatus } from '../../src/util/hwMetrics';

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

function makeDeps(projRoot: string, ollama: any) {
  const workspaceRootUri = vscode.Uri.file(projRoot);
  const events: AgentEvent[] = [];
  const deps = {
    ollama,
    pendingEdits: new PendingEditManager(workspaceRootUri),
    approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRootUri),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false, reason: 'not used in this test' }),
    chatMemorySearch: async () => [],
    workspaceRoot: workspaceRootUri,
    workspaceName: 'test',
  };
  return { deps, events, workspaceRootUri };
}

async function main() {
  const projRoot = path.resolve(__dirname, 'fixtures/proj');

  // ---------- isAutonomousMode ----------
  ok(isAutonomousMode('auto') === true, 'Auto mode is autonomous');
  ok(isAutonomousMode('outcome') === true, 'Outcome mode is autonomous (the 0.7.0 fix — it was silently false before)');
  ok(isAutonomousMode('agent') === false, 'Agent mode is not autonomous (still approval-gated)');
  ok(isAutonomousMode('ask') === false, 'Ask mode is not autonomous');
  ok(isAutonomousMode('plan') === false, 'Plan mode is not autonomous');

  // ---------- Outcome mode actually gets Auto mode's no-approval write behavior ----------
  vs.__resetConfig();
  vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20, 'forge.requireApprovalForWrites': true });
  const outcomeTargetPath = path.join(projRoot, 'outcome_write_test.txt');
  try { fs.unlinkSync(outcomeTargetPath); } catch { /* fine */ }
  let outcomeChatCalls = 0;
  const outcomeOllama = {
    chat: async () => {
      outcomeChatCalls++;
      if (outcomeChatCalls === 1) {
        return '```forge_action\n{"tool": "write_file", "args": {"path": "outcome_write_test.txt", "content": "hello"}}\n```';
      }
      return 'Done.';
    },
  };
  {
    const { deps, events } = makeDeps(projRoot, outcomeOllama);
    const cts = new vscode.CancellationTokenSource();
    await runAgentTurn([], 'write a file', deps as any, (e: AgentEvent) => events.push(e), cts.token, 'fake-model', { mode: 'outcome' });
    ok(fs.existsSync(outcomeTargetPath), 'Outcome mode write_file is applied to disk immediately, with no approval step — same as Auto mode');
    if (fs.existsSync(outcomeTargetPath)) fs.unlinkSync(outcomeTargetPath);
  }

  // ---------- spawn_subagent: nested runAgentTurn, reports back to parent ----------
  vs.__resetConfig();
  vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20, 'forge.maxSubAgentDepth': 2, 'forge.subAgentMaxIterations': 10 });
  let subChatCalls = 0;
  const subCapturedNumCtx: (number | undefined)[] = [];
  const subOllama = {
    chat: async (opts: any) => {
      subChatCalls++;
      subCapturedNumCtx.push(opts.numCtx);
      if (subChatCalls === 1) {
        // Parent turn: delegate to a sub-agent.
        return '```forge_action\n{"tool": "spawn_subagent", "args": {"task": "investigate the failing build"}}\n```';
      }
      if (subChatCalls === 2) {
        // Sub-agent's own turn: answers directly, no further tool calls.
        return 'The build fails because of a missing semicolon.';
      }
      // Parent turn, after seeing the sub-agent's result.
      return 'Parent final answer: fixed based on sub-agent findings.';
    },
  };
  {
    const { deps, events } = makeDeps(projRoot, subOllama);
    const cts = new vscode.CancellationTokenSource();
    const result = await runAgentTurn([], 'figure out why the build is failing', deps as any, (e: AgentEvent) => events.push(e), cts.token, 'parent-model', { mode: 'auto', numCtx: 4096 });

    ok(subChatCalls === 3, 'three model calls total: parent delegates, sub-agent answers, parent concludes');
    ok(subCapturedNumCtx.every((n) => n === 4096), "the parent's numCtx override (4096) is threaded down into the sub-agent's own call, not silently reset to the global default");

    const start = events.find((e): e is Extract<AgentEvent, { type: 'subagent_start' }> => e.type === 'subagent_start');
    ok(!!start && start.depth === 1 && start.task === 'investigate the failing build', 'subagent_start fires with depth 1 and the delegated task text');

    const subResult = events.find((e): e is Extract<AgentEvent, { type: 'subagent_result' }> => e.type === 'subagent_result');
    ok(!!subResult && subResult.ok === true && subResult.summary === 'The build fails because of a missing semicolon.', "subagent_result carries the sub-agent's actual final answer back, ok=true");

    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.summary.includes('missing semicolon'));
    ok(!!toolResult && toolResult.ok === true, "the spawn_subagent tool call's own tool_result reflects the sub-agent's success, so the parent's transcript sees it as a normal tool observation");

    const finalEvent = events.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final');
    ok(!!finalEvent && finalEvent.text === 'Parent final answer: fixed based on sub-agent findings.', 'the parent turn concludes on its own final answer after incorporating the sub-agent result');

    ok(result.messages.some((m) => m.content.includes('[Tool "spawn_subagent" result]')), "the parent's persisted transcript records the spawn_subagent call like any other tool call");

    const statusEvents = events.filter((e): e is Extract<AgentEvent, { type: 'status' }> => e.type === 'status');
    ok(statusEvents.some((e) => /delegating to a sub-agent/i.test(e.text)), 'a brief status message announces delegation to a sub-agent (item "brief messages…")');
    ok(statusEvents.some((e) => /thinking with parent-model/i.test(e.text)), 'a brief status message announces which model is thinking (item "brief messages…")');
  }

  // ---------- spawn_subagent: nesting depth cap is enforced ----------
  vs.__resetConfig();
  vs.__setConfig({ 'forge.numCtx': 8192, 'forge.maxAgentIterations': 20, 'forge.autoModeMaxIterations': 20, 'forge.maxSubAgentDepth': 1 });
  let depthChatCalls = 0;
  const depthOllama = {
    chat: async () => {
      depthChatCalls++;
      if (depthChatCalls === 1) return '```forge_action\n{"tool": "spawn_subagent", "args": {"task": "nested task"}}\n```';
      return 'done anyway';
    },
  };
  {
    const { deps, events } = makeDeps(projRoot, depthOllama);
    const cts = new vscode.CancellationTokenSource();
    // Simulate this turn ALREADY being a depth-1 sub-agent (i.e. at the
    // configured max depth) trying to spawn one more level.
    await runAgentTurn([], 'nested', deps as any, (e: AgentEvent) => events.push(e), cts.token, 'fake-model', { mode: 'auto', subAgentDepth: 1 });
    const refused = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && /refused/i.test(e.summary));
    ok(!!refused && refused.ok === false, 'a sub-agent already at the configured max depth is refused when it tries to spawn another sub-agent');
    ok(!events.some((e) => e.type === 'subagent_start'), 'no nested runAgentTurn is actually started for the refused spawn — the refusal short-circuits before recursing');
  }

  // ---------- ChatStore.rename() ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rename-test-'));
  const root = vscode.Uri.file(tmp);
  const store = new ChatStore(root);
  const now = new Date().toISOString();
  await store.save({ id: 'r1', title: 'Original title', mode: 'agent', model: 'm', createdAt: now, updatedAt: now, uiHistory: [], modelHistory: [] });
  await store.rename('r1', '  My renamed chat  ');
  const renamedSummary = (await store.listSessions()).find((s) => s.id === 'r1');
  ok(!!renamedSummary && renamedSummary.title === 'My renamed chat', 'rename() updates the index title, trimmed');
  const renamedStored = await store.load('r1');
  ok(!!renamedStored && renamedStored.title === 'My renamed chat' && renamedStored.titleManuallySet === true, 'rename() also updates the full session file and sets titleManuallySet');
  await store.rename('r1', '   ');
  const afterBlankAttempt = (await store.listSessions()).find((s) => s.id === 'r1');
  ok(!!afterBlankAttempt && afterBlankAttempt.title === 'My renamed chat', 'rename() with a blank/whitespace-only title is a no-op, not a silent clear');
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------- hwMetrics.getRamStatus ----------
  const ram = getRamStatus();
  ok(ram.totalGB > 0, 'getRamStatus() reports a positive total RAM figure');
  ok(ram.usedGB >= 0 && ram.usedGB <= ram.totalGB + 0.01, 'getRamStatus() reports used RAM within [0, total]');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.5.0 (0.7.0 release) runtime tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
