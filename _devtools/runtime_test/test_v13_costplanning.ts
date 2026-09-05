// Runtime tests for 0.13.0's cost-aware task planning — the extension of the
// 0.12.0 mandatory task ledger that estimates each plan_tasks entry's rough
// cost tier (cheap/moderate/expensive), shows an aggregate plan-cost figure,
// and either pauses for approval (non-autonomous modes) or posts a
// non-blocking warning (Auto/Outcome, or the review setting off) once a
// plan's weighted cost crosses forge.taskLedger.expensivePlanReviewThreshold.
// See agent/taskCost.ts, tools/taskLedgerTools.ts, and agentLoop.ts's
// ToolExecContext.config wiring. Same ok()/main() harness as every other
// test_v*.ts.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { estimateCostHeuristic, summarizePlanCost, renderPlanCostLine, renderPlanReviewDetail, renderPlanCostWarning, isCostTier } from '../../src/agent/taskCost';
import { TaskLedger, renderTaskLedgerForPrompt } from '../../src/agent/taskLedger';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';

const vs: any = vscode;

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

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v13-costplan-test-'));
  return vscode.Uri.file(tmp);
}

/** Mirrors ChatSession's real taskLedger.addTasks closure (src/chat/chatSession.ts) against a real TaskLedger instance, same as test_v12_orchestration.ts. */
function ledgerImplFor(l: TaskLedger) {
  return {
    addTasks: (tasks: any[], parentTaskId?: string) =>
      tasks.map((t) => {
        const description = typeof t === 'string' ? t : t.description;
        const costTier = typeof t === 'string' ? undefined : t.costTier;
        const costNote = typeof t === 'string' ? undefined : t.costNote;
        return l.add(description, parentTaskId, costTier, costNote).id;
      }),
    updateTask: (id: string, status: any, summary?: string) => !!l.setStatus(id, status, summary),
    list: () => l.list(),
  };
}

function baseDeps(workspaceRoot: vscode.Uri, events: AgentEvent[], fakeOllama: any, taskLedgerImpl: any) {
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
    taskLedger: taskLedgerImpl,
    workspaceRoot,
    workspaceName: 'test',
  };
}

// ============================================================================
// estimateCostHeuristic / summarizePlanCost / renderPlanCostLine — pure functions
// ============================================================================
function testHeuristicAndSummary() {
  ok(estimateCostHeuristic('Refactor the auth module to use the new session store') === 'expensive', 'a "refactor" task is heuristically expensive');
  ok(estimateCostHeuristic('Migrate the database schema to the new format') === 'expensive', 'a "migrate" task is heuristically expensive');
  ok(estimateCostHeuristic('Rewrite the entire codebase to use TypeScript') === 'expensive', 'a "rewrite the entire" task is heuristically expensive');
  ok(estimateCostHeuristic('Read the config file to see the current timeout') === 'cheap', 'a "read" task is heuristically cheap');
  ok(estimateCostHeuristic('Fix the typo in the README') === 'cheap', 'a "typo" task is heuristically cheap');
  ok(estimateCostHeuristic('Rename the getUser function to fetchUser') === 'cheap', 'a "rename" task is heuristically cheap');
  ok(estimateCostHeuristic('Investigate why the build is failing') === 'moderate', 'an ambiguous task (no expensive or cheap signal) defaults to moderate, not a guess in either direction');

  ok(isCostTier('cheap') && isCostTier('moderate') && isCostTier('expensive'), 'isCostTier accepts all three real tiers');
  ok(!isCostTier('free') && !isCostTier(undefined) && !isCostTier(3), 'isCostTier rejects anything else');

  const summary = summarizePlanCost([{ costTier: 'cheap' }, { costTier: 'cheap' }, { costTier: 'moderate' }, { costTier: 'expensive' }]);
  ok(summary.cheap === 2 && summary.moderate === 1 && summary.expensive === 1 && summary.total === 4, `summarizePlanCost counts each tier correctly (got ${JSON.stringify(summary)})`);
  ok(summary.score === 2 * 1 + 1 * 3 + 1 * 8, `summarizePlanCost's weighted score matches cheap=1/moderate=3/expensive=8 (got ${summary.score})`);

  const untiered = summarizePlanCost([{}, { costTier: undefined }]);
  ok(untiered.moderate === 2 && untiered.score === 6, 'an entry with no costTier at all is treated as moderate, matching TaskLedger.add()\'s own fallback reasoning');

  const line = renderPlanCostLine(summary);
  ok(/2 cheap/.test(line) && /1 moderate/.test(line) && /1 expensive/.test(line) && new RegExp(String(summary.score)).test(line), `renderPlanCostLine reads legibly (got "${line}")`);

  const empty = renderPlanCostLine(summarizePlanCost([]));
  ok(/no tasks/.test(empty), 'renderPlanCostLine handles an empty plan without producing a malformed sentence');
}

// ============================================================================
// TaskLedger.add() auto-fills a cost tier; renderTaskLedgerForPrompt shows it
// ============================================================================
function testLedgerCostIntegration() {
  const ledger = new TaskLedger();
  const explicit = ledger.add('Do a thing', undefined, 'expensive', 'touches every module');
  ok(explicit.costTier === 'expensive', 'add() keeps an explicitly-provided costTier rather than overriding it with the heuristic');
  ok(explicit.costNote === 'touches every module', 'add() keeps the provided costNote');

  const inferred = ledger.add('Fix the typo in the README');
  ok(inferred.costTier === 'cheap', 'add() falls back to the heuristic when no costTier is given');
  ok(inferred.costNote === undefined, 'the heuristic fallback never fabricates a costNote');

  const rendered = renderTaskLedgerForPrompt(ledger.list())!;
  ok(/\(expensive\) Do a thing/.test(rendered), 'the rendered ledger tags the expensive task with its tier');
  ok(/\(cheap\) Fix the typo/.test(rendered), 'the rendered ledger tags the cheap task with its tier');
  ok(/Remaining task cost:/.test(rendered), 'the rendered ledger includes an aggregate cost-summary line');
  ok(/cheap-first|cheap tasks first/.test(rendered), 'the rendered ledger explains the cheap-first ordering rationale to the model');

  // fromJSON round-trip preserves cost fields (old pre-0.13.0 sessions simply
  // won't have them — costTier/costNote are optional on the type for exactly
  // that reason — but a fresh ledger must round-trip them faithfully).
  const roundTripped = TaskLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  ok(roundTripped.get(explicit.id)?.costTier === 'expensive', 'costTier survives a JSON round-trip');
  ok(roundTripped.get(explicit.id)?.costNote === 'touches every module', 'costNote survives a JSON round-trip');
}

// ============================================================================
// renderPlanReviewDetail / renderPlanCostWarning — approval-card / advisory text
// ============================================================================
function testReviewAndWarningText() {
  const entries = [
    { description: 'Refactor the config loader', costTier: 'expensive' as const, costNote: 'touches every module' },
    { description: 'Update the README', costTier: 'cheap' as const },
  ];
  const summary = summarizePlanCost(entries);
  const detail = renderPlanReviewDetail(entries, summary, 8);
  ok(/\[EXPENSIVE\] Refactor the config loader — touches every module/.test(detail), 'renderPlanReviewDetail tags and explains the expensive task');
  ok(/\[cheap\] Update the README/.test(detail), 'renderPlanReviewDetail tags the cheap task without inventing a note it doesn\'t have');
  ok(/threshold \(8\)/.test(detail), 'renderPlanReviewDetail names the actual threshold that was crossed');
  ok(/Approve to let the agent start|deny to have it revise/i.test(detail), 'renderPlanReviewDetail explains what approving/denying actually does');

  const warning = renderPlanCostWarning(summary, 8, 'an autonomous (Auto/Outcome)');
  ok(/autonomous \(Auto\/Outcome\) mode/.test(warning), 'renderPlanCostWarning names the mode responsible for not pausing');
  ok(/doesn't pause for approval/.test(warning), 'renderPlanCostWarning explains why it didn\'t block');
}

// ============================================================================
// planTasksTool end-to-end through runAgentTurn — the real integration
// ============================================================================
async function testPlanToolBelowThreshold() {
  vs.__resetConfig();
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  let call = 0;
  const fakeOllama: any = {
    chat: async () => {
      call++;
      if (call === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": [{"description": "Read the config file", "costTier": "cheap"}, {"description": "Add a comment explaining it", "costTier": "cheap"}]}}\n```';
      return 'Planned.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  await runAgentTurn([], 'plan a small task', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent', maxIterationsOverride: 3 });

  ok(l.list().length === 2, `a cheap plan (score well under the default threshold) is recorded without any approval round-trip (got ${l.list().length} entries)`);
  ok(!events.some((e) => e.type === 'approval_request'), 'no approval_request was emitted for a cheap plan');
  const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  ok(!!toolResult && toolResult.ok === true && /estimated cost/.test(toolResult.summary), `plan_tasks reports its cost estimate in the confirmation (got ${JSON.stringify(toolResult)})`);
  vs.__resetConfig();
}

async function testExpensivePlanBlocksAndApprove() {
  vs.__resetConfig();
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const fakeOllama: any = {
    chat: async () => {
      const calls = (fakeOllama as any)._n = ((fakeOllama as any)._n || 0) + 1;
      if (calls === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": [{"description": "Refactor the whole auth module", "costTier": "expensive", "costNote": "big blast radius"}]}}\n```';
      return 'Planned.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  const cts = new vscode.CancellationTokenSource();

  const turnPromise = runAgentTurn([], 'plan a big refactor', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent', maxIterationsOverride: 3 });

  // Wait for the blocking approval_request to actually arrive before
  // resolving it — runAgentTurn is genuinely paused on it at this point,
  // same shape as run_command's approval flow already relies on in
  // production (ChatSession.resolveApproval / ApprovalBroker.resolve).
  const approvalEvent = await waitFor(events, (e): e is Extract<AgentEvent, { type: 'approval_request' }> => e.type === 'approval_request');
  ok(approvalEvent.kind === 'plan_review', `the approval request is tagged as a plan review, not a command approval (got kind="${approvalEvent.kind}")`);
  ok(/EXPENSIVE/.test(approvalEvent.detail) && /big blast radius/.test(approvalEvent.detail), 'the approval detail shows the expensive tag and the model\'s own cost note');
  ok(l.list().length === 0, 'nothing is added to the ledger while the plan is still awaiting approval — same no-side-effect-until-approved behavior as run_command');

  deps.approvalBroker.resolve(approvalEvent.callId, true);
  await turnPromise;

  ok(l.list().length === 1, 'approving the plan review lets plan_tasks proceed and record the task');
  ok(l.list()[0].costTier === 'expensive', 'the recorded task keeps its expensive tier');
  vs.__resetConfig();
}

async function testExpensivePlanDenied() {
  vs.__resetConfig();
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const fakeOllama: any = {
    chat: async () => {
      const calls = (fakeOllama as any)._n = ((fakeOllama as any)._n || 0) + 1;
      if (calls === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": [{"description": "Refactor the whole auth module", "costTier": "expensive"}]}}\n```';
      return 'Understood, revising.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  const cts = new vscode.CancellationTokenSource();

  const turnPromise = runAgentTurn([], 'plan a big refactor', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent', maxIterationsOverride: 3 });
  const approvalEvent = await waitFor(events, (e): e is Extract<AgentEvent, { type: 'approval_request' }> => e.type === 'approval_request');
  deps.approvalBroker.resolve(approvalEvent.callId, false);
  await turnPromise;

  ok(l.list().length === 0, 'denying the plan review means nothing is added to the ledger at all');
  const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  ok(!!toolResult && toolResult.ok === false && /did not approve/.test(toolResult.summary), `plan_tasks reports the denial clearly and invites a revised plan (got ${JSON.stringify(toolResult)})`);
  vs.__resetConfig();
}

async function testExpensivePlanInAutoModeWarnsButDoesNotBlock() {
  vs.__resetConfig();
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const fakeOllama: any = {
    chat: async () => {
      const calls = (fakeOllama as any)._n = ((fakeOllama as any)._n || 0) + 1;
      if (calls === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": [{"description": "Refactor the whole auth module", "costTier": "expensive"}]}}\n```';
      return 'Planned.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  await runAgentTurn([], 'plan a big refactor autonomously', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'auto', maxIterationsOverride: 3 });

  ok(!events.some((e) => e.type === 'approval_request'), 'Auto mode never gets a blocking plan-review approval request, by design (isAutonomousMode)');
  ok(l.list().length === 1, 'the expensive task is still recorded in Auto mode — it just isn\'t gated on approval');
  const warningEvent = events.find((e): e is Extract<AgentEvent, { type: 'tool_warning' }> => e.type === 'tool_warning');
  ok(!!warningEvent && /autonomous \(Auto\/Outcome\)/.test(warningEvent.text), `Auto mode instead gets a visible, non-blocking tool_warning (got ${JSON.stringify(warningEvent)})`);
  vs.__resetConfig();
}

async function testReviewDisabledSettingStillWarnsInAgentMode() {
  vs.__resetConfig();
  vs.__setConfig({ 'forge.taskLedger.reviewExpensivePlans': false });
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const fakeOllama: any = {
    chat: async () => {
      const calls = (fakeOllama as any)._n = ((fakeOllama as any)._n || 0) + 1;
      if (calls === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": [{"description": "Refactor the whole auth module", "costTier": "expensive"}]}}\n```';
      return 'Planned.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  await runAgentTurn([], 'plan a big refactor', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent', maxIterationsOverride: 3 });

  ok(!events.some((e) => e.type === 'approval_request'), 'forge.taskLedger.reviewExpensivePlans: false skips the blocking review even in Agent mode');
  ok(l.list().length === 1, 'the task is still recorded');
  const warningEvent = events.find((e): e is Extract<AgentEvent, { type: 'tool_warning' }> => e.type === 'tool_warning');
  ok(!!warningEvent, 'the non-blocking warning still fires when review is turned off via settings, so the user isn\'t left with no signal at all');
  vs.__resetConfig();
}

async function testCostAwarePlanningDisabledRestoresOldBehavior() {
  vs.__resetConfig();
  vs.__setConfig({ 'forge.taskLedger.costAwarePlanning': false });
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const fakeOllama: any = {
    chat: async () => {
      const calls = (fakeOllama as any)._n = ((fakeOllama as any)._n || 0) + 1;
      if (calls === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": ["Refactor everything", "Migrate the whole database"]}}\n```';
      return 'Planned.';
    },
  };
  const l = new TaskLedger();
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledgerImplFor(l));
  await runAgentTurn([], 'plan with cost-awareness off', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent', maxIterationsOverride: 3 });

  ok(!events.some((e) => e.type === 'approval_request'), 'with forge.taskLedger.costAwarePlanning off, even an objectively expensive-sounding plan never triggers review');
  ok(l.list().length === 2, 'tasks are still recorded normally');
  // With the setting off, plan_tasks itself never estimates a cost or even
  // LOOKS at one (no review gate, no warning, no cost line in its own
  // response — see the two assertions above/below) — but TaskLedger.add()
  // unconditionally back-fills a heuristic tier for ANY entry regardless of
  // caller intent (the same "mandatory regardless of model/caller
  // discipline" guarantee spawn_subagent's auto-instrumentation relies on),
  // so the ledger itself still ends up with a tier per task. That's a
  // feature, not a leak: it's what lets the ledger's own rendering
  // (renderTaskLedgerForPrompt) always show a tier even for tasks added
  // through a code path that never thought about cost at all.
  ok(l.list().every((t) => t.costTier !== undefined), 'TaskLedger.add() itself still back-fills a heuristic tier even when plan_tasks\' own cost-aware logic is turned off — the ledger is never left with no tier at all');
  const toolResultNoCost = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  ok(!!toolResultNoCost && !/estimated cost/.test(toolResultNoCost.summary), 'but plan_tasks\' own confirmation message, with the setting off, does NOT mention an estimated cost — it genuinely behaves like pre-0.13.0');
  vs.__resetConfig();
}

/** Polls `events` for a predicate to become true — the blocking approval flow genuinely awaits a real Promise inside runAgentTurn, so the test has to wait for that event to actually land (a microtask away) before it can resolve it, same pattern any real ChatSession/webview round-trip already has to handle. */
function waitFor<T extends AgentEvent>(events: AgentEvent[], pred: (e: AgentEvent) => e is T, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = events.find(pred);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 5);
    };
    check();
  });
}

// ============================================================================
// main
// ============================================================================
async function main() {
  testHeuristicAndSummary();
  testLedgerCostIntegration();
  testReviewAndWarningText();
  await testPlanToolBelowThreshold();
  await testExpensivePlanBlocksAndApprove();
  await testExpensivePlanDenied();
  await testExpensivePlanInAutoModeWarnsButDoesNotBlock();
  await testReviewDisabledSettingStillWarnsInAgentMode();
  await testCostAwarePlanningDisabledRestoresOldBehavior();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.13.0 cost-aware task planning runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
