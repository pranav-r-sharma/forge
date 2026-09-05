// ============================================================================
// 0.14.0: checkpoint/resume, task logging, and sequential orchestration,
// unified around the task ledger (agent/taskLedger.ts) as designed together
// per the user's explicit request ("these three are genuinely one system").
//
// Three things this file locks down:
//   1. Single source of truth for task reporting: ChatStore.writeTaskReport()
//      now REGENERATES the whole .tasks.md file from current ledger state on
//      every change (renderTaskManifestMarkdown()), instead of the pre-0.14.0
//      design where it appended one Markdown section per event — a second,
//      independently-drifting representation of "what's true right now."
//   2. The literal per-task resumability manifest the request asked for:
//      ChatStore.writeTaskManifest() writes one small JSON file per task
//      under .forge/tasks/<sessionId>/<taskId>.json, kept current on every
//      status change, and cleaned up when the owning session is deleted.
//   3. resumeTaskId: spawn_subagent can now be told "this dispatch is
//      resuming an existing ledger entry," which (a) reuses that entry
//      instead of creating a duplicate, and (b) seeds the fresh sub-agent's
//      context with that entry's last known progress — fresh-seeded per the
//      user's explicit preference ("Fresh-seeded is cheaper... and probably
//      more robust"), not a full transcript replay.
//
// Mirrors every previous test_v*.ts file's ok()/main() harness.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLedger, renderTaskLedgerForPrompt, renderTaskManifestMarkdown } from '../../src/agent/taskLedger';
import { ChatStore } from '../../src/forge/chatStore';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { spawnSubAgentTool } from '../../src/tools/subAgentTool';

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

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v14-task-manifest-test-'));
  return vscode.Uri.file(tmp);
}

// ---------- renderTaskLedgerForPrompt: resumeTaskId's id tag ----------

function testPromptRenderExposesIdsForResumableTasksOnly() {
  const ledger = new TaskLedger();
  const pending = ledger.add('Investigate the flaky test');
  const inProgress = ledger.add('Migrate the config loader');
  const failed = ledger.add('Refactor the auth module');
  const done = ledger.add('Update the README');
  ledger.setStatus(inProgress.id, 'in_progress', 'Found the root cause, applying the fix next.');
  ledger.setStatus(failed.id, 'failed', 'Tried approach A, it broke the build.');
  ledger.setStatus(done.id, 'done', 'Done.');

  const rendered = renderTaskLedgerForPrompt(ledger.list())!;
  ok(rendered.includes(`[id: ${pending.id}]`), 'a pending task shows its ledger id so it can be referenced');
  ok(rendered.includes(`[id: ${inProgress.id}]`), 'an in_progress task shows its ledger id');
  ok(rendered.includes(`[id: ${failed.id}]`), 'a failed task shows its ledger id');
  ok(!rendered.includes(`[id: ${done.id}]`), 'a DONE task does not show an id — there is nothing to resume, so it is not worth the prompt tokens');
  ok(/resumeTaskId/.test(rendered), 'the rendered block explains what the id tag is for (resumeTaskId), not just showing a bare id with no context');
}

// ---------- renderTaskManifestMarkdown: full re-render, not an append-only event log ----------

function testManifestMarkdownIsAFullCurrentStateSnapshot() {
  ok(/no tasks recorded yet/.test(renderTaskManifestMarkdown([])), 'an empty ledger renders a clear placeholder, not a crash or blank file');

  const ledger = new TaskLedger();
  const parent = ledger.add('Investigate the build failure', undefined, 'moderate', 'touches CI config');
  const child = ledger.add('Check the lockfile', parent.id);
  ledger.setStatus(parent.id, 'in_progress');
  ledger.setStatus(child.id, 'done', 'Lockfile was stale; regenerated.');
  (ledger.get(parent.id) as any).checkpointId = 'ckpt_abc123';

  const rendered = renderTaskManifestMarkdown(ledger.list());
  ok(rendered.includes(parent.id) && rendered.includes(child.id), 'both tasks appear, identified by their real ledger ids');
  ok(rendered.includes('Check the lockfile') && rendered.includes('Lockfile was stale; regenerated.'), 'the child task\'s full, untruncated description and summary both appear');
  ok(rendered.includes('checkpoint: `ckpt_abc123`'), 'a linked checkpoint id is rendered when present (0.14.0 task-to-checkpoint linkage)');
  ok(rendered.includes('cost: moderate (touches CI config)'), 'cost tier and note are rendered when present, same info the in-prompt digest shows');
  ok(/1 done, 0 failed, 1 pending\/in-progress/.test(rendered), 'the header aggregate counts match the actual ledger state');

  // The key 0.14.0 property: re-rendering after a further change reflects
  // the NEW current state, not an accumulation of every historical state —
  // there is exactly one "Check the lockfile" section, not two.
  ledger.setStatus(child.id, 'done', 'Lockfile was stale; regenerated. (verified again on retry)');
  const rerendered = renderTaskManifestMarkdown(ledger.list());
  const occurrences = (rerendered.match(/## \[x\] Check the lockfile/g) || []).length;
  ok(occurrences === 1, `re-rendering after a further status/summary change still shows exactly ONE section per task with its latest summary, not an accumulating history (got ${occurrences} sections)`);
  ok(rerendered.includes('verified again on retry'), 'the single section reflects the latest summary');
}

// ---------- ChatStore.writeTaskManifest / writeTaskReport / delete cleanup ----------

async function testChatStorePerTaskManifestFiles() {
  const tmp = freshWorkspace();
  const store = new ChatStore(tmp);
  const ledger = new TaskLedger();
  const t1 = ledger.add('Fix the build');
  const t2 = ledger.add('Fix the tests');
  ledger.setStatus(t1.id, 'in_progress', 'Looking at the CI logs.');

  await store.writeTaskManifest('sess1', ledger.get(t1.id)!);
  await store.writeTaskManifest('sess1', ledger.get(t2.id)!);

  const manifestDir = store.taskManifestDir('sess1');
  ok(fs.existsSync(path.join(manifestDir, `${t1.id}.json`)), 'a per-task JSON manifest file exists at .forge/tasks/<sessionId>/<taskId>.json — the literal resumability file the request asked for');
  ok(fs.existsSync(path.join(manifestDir, `${t2.id}.json`)), 'a second task gets its own separate manifest file');

  const manifest1 = JSON.parse(fs.readFileSync(path.join(manifestDir, `${t1.id}.json`), 'utf8'));
  ok(manifest1.sessionId === 'sess1', 'the manifest carries the owning sessionId — the closest equivalent to a "pointer to its mini-transcript" given Forge\'s fresh-seeded sub-agent design (see the doc comment)');
  ok(manifest1.status === 'in_progress' && manifest1.summary === 'Looking at the CI logs.', 'the manifest reflects the task\'s actual current definition/status/summary');
  ok(manifest1.id === t1.id, 'the manifest is keyed by, and also carries, the real task id');

  // Overwrite, not append — updating a task rewrites its OWN file in place.
  ledger.setStatus(t1.id, 'done', 'Stale lockfile; regenerated.');
  await store.writeTaskManifest('sess1', ledger.get(t1.id)!);
  const manifest1b = JSON.parse(fs.readFileSync(path.join(manifestDir, `${t1.id}.json`), 'utf8'));
  ok(manifest1b.status === 'done' && manifest1b.summary === 'Stale lockfile; regenerated.', 'a later writeTaskManifest() call for the same task id overwrites its file with the latest state rather than accumulating');

  // ---- writeTaskReport regenerates the whole file, not appends ----
  await store.writeTaskReport('sess1', ledger.list());
  const reportPath = store.taskReportPath('sess1');
  const report1 = fs.readFileSync(reportPath, 'utf8');
  ok(report1.includes('Fix the build') && report1.includes('Fix the tests'), 'the report reflects every current task');

  ledger.setStatus(t2.id, 'done', 'Flaky test fixed.');
  await store.writeTaskReport('sess1', ledger.list());
  const report2 = fs.readFileSync(reportPath, 'utf8');
  const fixBuildOccurrences = (report2.match(/Fix the build/g) || []).length;
  ok(fixBuildOccurrences === 1, `writing the report again after an unrelated task's change still shows "Fix the build" exactly once (full re-render), not accumulated across every write (got ${fixBuildOccurrences})`);
  ok(report2.includes('Flaky test fixed.'), 'the regenerated report includes the newly-completed task\'s outcome');

  // ---- delete() cleans up the whole per-session manifest directory ----
  await store.save({ id: 'sess1', title: 'Test', mode: 'agent', model: 'x', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), uiHistory: [], modelHistory: [] });
  ok(fs.existsSync(manifestDir), 'sanity: the manifest directory exists before delete');
  await store.delete('sess1');
  ok(!fs.existsSync(manifestDir), 'delete() removes the whole per-session task-manifest directory, not just the session/log/report files');
  ok(!fs.existsSync(reportPath), 'delete() still removes the .tasks.md report file too (pre-existing behavior, unchanged)');

  fs.rmSync(tmp.fsPath, { recursive: true, force: true });
}

// ---------- resumeTaskId: reuses an existing ledger entry and seeds context from it ----------

function baseDeps(workspaceRoot: vscode.Uri, events: AgentEvent[], fakeOllama: any, ledger: TaskLedger) {
  const taskLedgerImpl = {
    addTasks: (tasks: any[], parentTaskId?: string) =>
      tasks.map((t) => {
        const description = typeof t === 'string' ? t : t.description;
        const costTier = typeof t === 'string' ? undefined : t.costTier;
        const costNote = typeof t === 'string' ? undefined : t.costNote;
        return ledger.add(description, parentTaskId, costTier, costNote).id;
      }),
    updateTask: (id: string, status: any, summary?: string) => !!ledger.setStatus(id, status, summary),
    list: () => ledger.list(),
  };
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

async function testResumeTaskIdReusesExistingEntryAndSeedsContext() {
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const ledger = new TaskLedger();
  const existing = ledger.add('Migrate the config loader to the new schema');
  ledger.setStatus(existing.id, 'in_progress', 'Rewrote loadConfig(); still need to update the 3 call sites in src/tools/.');

  let call = 0;
  const capturedSubAgentMessages: any[] = [];
  const fakeOllama: any = {
    chat: async (opts: any) => {
      call++;
      if (call === 1) {
        // Top-level model dispatches spawn_subagent with resumeTaskId.
        return `\`\`\`forge_action\n{"tool": "spawn_subagent", "args": {"task": "Finish migrating the config loader", "resumeTaskId": "${existing.id}"}}\n\`\`\``;
      }
      if (call === 2) {
        // This is the NESTED sub-agent's own first model call — capture what it was seeded with.
        capturedSubAgentMessages.push(...opts.messages);
        return 'Updated the 3 call sites; migration complete.';
      }
      return 'Great, thanks.';
    },
  };
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledger);
  await runAgentTurn([], 'continue where we left off', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent' });

  ok(ledger.list().length === 1, `resuming an existing task does not create a duplicate ledger entry (got ${ledger.list().length} total)`);
  ok(ledger.get(existing.id)?.status === 'done', 'the ORIGINAL entry (same id) ends up done, not a new entry');
  ok(/migration complete/i.test(ledger.get(existing.id)?.summary || ''), 'the original entry\'s summary is updated with the resumed sub-agent\'s actual new outcome');

  const seededText = capturedSubAgentMessages.map((m) => m.content).join('\n');
  ok(new RegExp(`Resuming task ${existing.id}`).test(seededText), 'the fresh sub-agent is told which task id it is resuming');
  ok(/Rewrote loadConfig\(\); still need to update the 3 call sites/.test(seededText), 'the sub-agent\'s seeded context includes the ORIGINAL entry\'s last known summary — this is the "fresh-seeded with a summary, not full transcript replay" design');
  ok(/Finish migrating the config loader/.test(seededText), 'the sub-agent still receives the new task description alongside the resumed context');
}

async function testUnknownResumeTaskIdFallsBackToCreatingANewEntry() {
  const workspaceRoot = freshWorkspace();
  const events: AgentEvent[] = [];
  const ledger = new TaskLedger();
  let call = 0;
  const fakeOllama: any = {
    chat: async () => {
      call++;
      if (call === 1) return '```forge_action\n{"tool": "spawn_subagent", "args": {"task": "Investigate the timeout", "resumeTaskId": "task_does_not_exist"}}\n```';
      if (call === 2) return 'Found a slow query.';
      return 'Thanks.';
    },
  };
  const deps: any = baseDeps(workspaceRoot, events, fakeOllama, ledger);
  await runAgentTurn([], 'investigate', deps, (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', { mode: 'agent' });

  ok(ledger.list().length === 1, 'a resumeTaskId that does not exist in the ledger falls back to creating a normal new entry rather than failing the whole call');
  ok(ledger.list()[0].description === 'Investigate the timeout', 'the newly-created fallback entry uses the task description as normal');
  ok(ledger.list()[0].status === 'done', 'the fallback entry still completes normally end to end');
}

// ---------- subAgentTool.ts arg parsing for resumeTaskId ----------

async function testSubAgentToolParsesResumeTaskIdArg() {
  let capturedResumeTaskId: string | undefined | null = null;
  const fakeCtx: any = {
    spawnSubAgent: async (task: string, contextHint?: string, resumeTaskId?: string) => {
      capturedResumeTaskId = resumeTaskId;
      return { ok: true, summary: 'done' };
    },
  };
  await spawnSubAgentTool({ task: 'do the thing', resumeTaskId: 'task_xyz_1' }, fakeCtx);
  ok(capturedResumeTaskId === 'task_xyz_1', `a string resumeTaskId arg is passed straight through to ctx.spawnSubAgent (got ${JSON.stringify(capturedResumeTaskId)})`);

  await spawnSubAgentTool({ task: 'do another thing', resumeTaskId: '   ' }, fakeCtx);
  ok(capturedResumeTaskId === undefined, 'a whitespace-only resumeTaskId is treated as absent, not passed through as a bogus id');

  await spawnSubAgentTool({ task: 'do a third thing' }, fakeCtx);
  ok(capturedResumeTaskId === undefined, 'omitting resumeTaskId entirely passes undefined through, same as before this feature existed');

  await spawnSubAgentTool({ task: 'do a fourth thing', resumeTaskId: 42 as any }, fakeCtx);
  ok(capturedResumeTaskId === undefined, 'a non-string resumeTaskId (model sent the wrong type) is ignored rather than crashing or being coerced');
}

async function main() {
  testPromptRenderExposesIdsForResumableTasksOnly();
  testManifestMarkdownIsAFullCurrentStateSnapshot();
  await testChatStorePerTaskManifestFiles();
  await testResumeTaskIdReusesExistingEntryAndSeedsContext();
  await testUnknownResumeTaskIdFallsBackToCreatingANewEntry();
  await testSubAgentToolParsesResumeTaskIdArg();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.14.0 task-manifest/resume runtime tests FAILED.');
    process.exit(1);
  } else {
    console.log('All v0.14.0 task-manifest/resume runtime tests passed.');
  }
}

main().catch((err) => {
  console.error('Uncaught error in test_v14_task_manifest.ts:', err);
  process.exit(1);
});
