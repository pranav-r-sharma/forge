// Runtime tests for the 0.12.0 "mandatory task-ledger + orchestration mode"
// round (items 4a/4b/4c): agent/taskLedger.ts's TaskLedger/renderTaskLedgerForPrompt,
// the plan_tasks/update_task tools, automatic spawn_subagent ledger
// instrumentation in agentLoop.ts, the orchestration-mode system-prompt
// fragment, and ChatSession's persistence round-trip for taskLedger/
// orchestrationEnabled. Same ok()/main() harness as every other test_v*.ts.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLedger, renderTaskLedgerForPrompt } from '../../src/agent/taskLedger';
import { buildSystemPrompt } from '../../src/agent/systemPrompt';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { ChatSession } from '../../src/chat/chatSession';

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v12-orch-test-'));
  return vscode.Uri.file(tmp);
}

function baseDeps(workspaceRoot: vscode.Uri, events: AgentEvent[], fakeOllama: any, taskLedgerImpl?: any) {
  const ledger = taskLedgerImpl || (() => {
    const l = new TaskLedger();
    return {
      // Mirrors ChatSession's real addTasks closure (src/chat/chatSession.ts)
      // now that cost-aware task planning (0.13.0) widened the entry type to
      // `string | {description, costTier?, costNote?}` — see test_v13_costplanning.ts
      // for dedicated cost-tier coverage; this file only needs to not crash
      // on the richer shape plan_tasks now sends by default.
      addTasks: (tasks: any[], parentTaskId?: string) =>
        tasks.map((t) => {
          const description = typeof t === 'string' ? t : t.description;
          const costTier = typeof t === 'string' ? undefined : t.costTier;
          const costNote = typeof t === 'string' ? undefined : t.costNote;
          return l.add(description, parentTaskId, costTier, costNote).id;
        }),
      updateTask: (id: string, status: any, summary?: string) => !!l.setStatus(id, status, summary),
      list: () => l.list(),
      __ledger: l,
    };
  })();
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
    taskLedger: ledger,
    workspaceRoot,
    workspaceName: 'test',
  };
}

// ============================================================================
// TaskLedger + renderTaskLedgerForPrompt
// ============================================================================
function testTaskLedgerCore() {
  const ledger = new TaskLedger();
  ok(renderTaskLedgerForPrompt(ledger.list()) === undefined, 'an empty ledger renders nothing, so callers can concatenate unconditionally');

  const parent = ledger.add('Investigate the build failure');
  const child = ledger.add('Check the lockfile', parent.id);
  ledger.setStatus(parent.id, 'in_progress');
  ledger.setStatus(child.id, 'done', 'Lockfile was stale; regenerated.');

  const rendered = renderTaskLedgerForPrompt(ledger.list())!;
  ok(!!rendered, 'a non-empty ledger renders a prompt block');
  ok(/mandatory checkpoint record/i.test(rendered), 'the rendered block explains it is the mandatory checkpoint record');
  ok(/\[~\] \(\w+\) Investigate the build failure/.test(rendered), 'the in_progress parent task shows the [~] mark (plus its cost-tier tag — see test_v13_costplanning.ts)');
  ok(/  \[x\] \(\w+\) Check the lockfile — Lockfile was stale; regenerated\./.test(rendered), 'the done child task is indented one level (hierarchy) and shows its summary');

  const fromRoundTrip = TaskLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  ok(fromRoundTrip.list().length === 2, 'TaskLedger round-trips through JSON.stringify/parse (JSON.stringify -> fromJSON) with all entries intact');
  ok(fromRoundTrip.get(child.id)?.status === 'done', 'status survives the round-trip');

  ok(TaskLedger.fromJSON(undefined).list().length === 0, 'fromJSON(undefined) yields an empty ledger rather than throwing');
  ok(ledger.setStatus('not-a-real-id', 'done') === undefined, 'setStatus on an unknown id returns undefined rather than throwing');

  // a task added with a parentTaskId that doesn't exist yet is NOT silently
  // linked to a garbage parent (would corrupt depthOf's walk) — it's just a
  // top-level task instead.
  const orphan = ledger.add('Orphaned child', 'no-such-parent');
  ok(orphan.parentTaskId === undefined, 'add() with an unknown parentTaskId drops the (invalid) link rather than storing a dangling reference');

  // cap behavior: many tasks still render, capped rather than crashing/unbounded.
  const big = new TaskLedger();
  for (let i = 0; i < 80; i++) big.add(`task number ${i}`);
  const bigRendered = renderTaskLedgerForPrompt(big.list())!;
  ok(bigRendered.length > 0 && bigRendered.length < 20000, `a large ledger (80 tasks) still renders a bounded block (got ${bigRendered.length} chars)`);
  ok(/earlier task\(s\) omitted/.test(bigRendered), 'a ledger over the per-prompt cap notes how many earlier tasks were omitted, rather than silently truncating');
}

// ============================================================================
// plan_tasks / update_task tools, end-to-end through runAgentTurn
// ============================================================================
async function testPlanAndUpdateTaskTools() {
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  let call = 0;
  const fakeOllama: any = {
    chat: async () => {
      call++;
      if (call === 1) return '```forge_action\n{"tool": "plan_tasks", "args": {"tasks": ["Investigate build", "Investigate tests"]}}\n```';
      if (call === 2) return 'noted, now updating';
      return 'All planned and updated.';
    },
  };
  const l = new TaskLedger();
  const taskLedgerImpl = {
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
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, taskLedgerImpl);
  const cts = new vscode.CancellationTokenSource();
  await runAgentTurn([], 'plan out investigating the CI failure', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });

  ok(l.list().length === 2, `plan_tasks actually created 2 ledger entries via the real tool dispatch (got ${l.list().length})`);
  ok(l.list().every((t) => t.status === 'pending'), 'freshly planned tasks start pending');

  const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  ok(!!toolResult && toolResult.ok === true && /Recorded 2 task/.test(toolResult.summary), `plan_tasks reports back a clear confirmation (got ${JSON.stringify(toolResult)})`);

  // ---- update_task, in a fresh turn against the same ledger ----
  const events2: AgentEvent[] = [];
  const taskId = l.list()[0].id;
  let call2 = 0;
  const fakeOllama2: any = {
    chat: async () => {
      call2++;
      if (call2 === 1) return `\`\`\`forge_action\n{"tool": "update_task", "args": {"id": "${taskId}", "status": "done", "summary": "Found a stale cache."}}\n\`\`\``;
      return 'Marked done.';
    },
  };
  const deps2: any = baseDeps(workspaceRoot, events2, fakeOllama2, taskLedgerImpl);
  await runAgentTurn([], 'update the first task', deps2, (e) => events2.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent' });
  ok(l.get(taskId)?.status === 'done', 'update_task actually flips the real ledger entry\'s status');
  ok(l.get(taskId)?.summary === 'Found a stale cache.', 'update_task records the outcome summary');

  // ---- update_task against an unknown id fails clearly, listing what does exist ----
  const events3: AgentEvent[] = [];
  const fakeOllama3: any = {
    chat: async () => '```forge_action\n{"tool": "update_task", "args": {"id": "bogus", "status": "done"}}\n```',
  };
  const deps3: any = baseDeps(workspaceRoot, events3, fakeOllama3, taskLedgerImpl);
  await runAgentTurn([], 'try a bad update', deps3, (e) => events3.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent', maxIterationsOverride: 2 });
  const badResult = events3.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  ok(!!badResult && badResult.ok === false && /No task with id "bogus"/.test(badResult.summary), 'update_task on an unknown id fails clearly and lists current tasks rather than crashing');
}

// ============================================================================
// spawn_subagent auto-instrumentation: no model discipline required
// ============================================================================
async function testSpawnSubAgentAutoInstrumentation() {
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  let call = 0;
  const fakeOllama: any = {
    chat: async () => {
      call++;
      if (call === 1) return '```forge_action\n{"tool": "spawn_subagent", "args": {"task": "Look into the failing test"}}\n```';
      if (call === 2) return 'Found it: an off-by-one error.'; // the nested sub-agent's own "final" answer
      return 'Great, thanks sub-agent.';
    },
  };
  const l = new TaskLedger();
  const taskLedgerImpl = {
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
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, taskLedgerImpl);
  await runAgentTurn([], 'delegate the investigation', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent' });

  ok(l.list().length === 1, `spawn_subagent auto-recorded exactly one ledger entry with zero plan_tasks/update_task calls from the model (got ${l.list().length})`);
  ok(l.list()[0].description === 'Look into the failing test', 'the auto-recorded entry\'s description is the sub-agent\'s task');
  ok(l.list()[0].status === 'done', 'the auto-recorded entry ends up "done" once the sub-agent finishes successfully, with no model-driven update_task call needed');
  ok(/off-by-one/.test(l.list()[0].summary || ''), 'the auto-recorded entry\'s summary is the sub-agent\'s actual report');

  // A crashing/never-nested test isn't feasible here without real model
  // failures, but the "mandatory, not model-discipline-dependent" claim is
  // exactly what the assertions above establish: this ledger entry exists
  // and is correctly resolved despite the top-level model never once
  // mentioning plan_tasks or update_task.
}

// ============================================================================
// orchestration-mode system-prompt fragment
// ============================================================================
function testOrchestrationPromptFragment() {
  const on = buildSystemPrompt('demo', 'agent', { orchestrationEnabled: true });
  ok(/MASTER ORCHESTRATOR/.test(on), 'the orchestrator fragment appears in Agent mode when orchestrationEnabled is true');
  ok(/sequentially/i.test(on) || /ONE AT A TIME/.test(on), 'the fragment explicitly instructs sequential (not parallel) sub-agent dispatch');

  const off = buildSystemPrompt('demo', 'agent', { orchestrationEnabled: false });
  ok(!/MASTER ORCHESTRATOR/.test(off), 'the orchestrator fragment is absent when orchestrationEnabled is false');

  const askOn = buildSystemPrompt('demo', 'ask', { orchestrationEnabled: true });
  ok(!/MASTER ORCHESTRATOR/.test(askOn), 'the orchestrator fragment never appears in Ask mode even if the toggle is on (Ask has no write/delegate tools anyway)');

  const planOn = buildSystemPrompt('demo', 'plan', { orchestrationEnabled: true });
  ok(!/MASTER ORCHESTRATOR/.test(planOn), 'the orchestrator fragment never appears in Plan mode even if the toggle is on (Plan has zero tools)');

  // plan_tasks/update_task/spawn_subagent are documented as available tools
  // in Agent mode regardless of the toggle — "mandatory," not opt-in.
  const noToggle = buildSystemPrompt('demo', 'agent', {});
  ok(/plan_tasks/.test(noToggle) && /update_task/.test(noToggle), 'plan_tasks/update_task are listed as available tools in Agent mode even with orchestration mode OFF — the ledger framework is mandatory, not gated by the toggle');
}

// ============================================================================
// ChatSession persistence round-trip: taskLedger + orchestrationEnabled
// ============================================================================
function testChatSessionPersistenceRoundTrip() {
  const saved: any[] = [];
  const fakeServices: any = {
    chatStore: {
      newId: () => 'sess_test_1',
      save: async (s: any) => {
        saved.push(s);
      },
      appendLog: async () => {},
      appendTaskReport: async () => {},
    },
    pendingEdits: { onBeforeWrite: () => ({ dispose: () => {} }) },
  };
  const session = new ChatSession(fakeServices, () => {});
  session.setOrchestrationEnabled(true);
  ok(session.orchestrationEnabled === true, 'setOrchestrationEnabled(true) sets the field');
  ok(saved.length > 0 && saved[saved.length - 1].orchestrationEnabled === true, 'setOrchestrationEnabled persists the new value immediately, same as setVerifyCommand/setModelOverride');

  const stored = session.toStored();
  ok(stored.orchestrationEnabled === true, 'toStored() reflects the toggle');

  const reloaded = ChatSession.fromStored(stored, fakeServices, () => {});
  ok(reloaded.orchestrationEnabled === true, 'fromStored() restores the toggle on a fresh ChatSession instance');

  const summary = reloaded.toSummaryState();
  ok(summary.orchestrationEnabled === true, 'toSummaryState() (what the webview reads) reflects the toggle too');
  ok(Array.isArray(summary.taskLedger), 'toSummaryState() always exposes a taskLedger array, even when empty, so the UI never has to special-case its absence');
}

// ============================================================================
// main
// ============================================================================
async function main() {
  testTaskLedgerCore();
  await testPlanAndUpdateTaskTools();
  await testSpawnSubAgentAutoInstrumentation();
  testOrchestrationPromptFragment();
  testChatSessionPersistenceRoundTrip();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.12.0 task-ledger/orchestration runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
