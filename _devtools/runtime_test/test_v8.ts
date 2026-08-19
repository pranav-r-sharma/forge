// Runtime tests for the 0.9.0 round (the 5-item feature/bug-fix request):
// item 4 (ChatStore.recoverCorruptedSession — "older chats don't open"),
// item 1's milestone-logging half (chat/milestones.ts, CheckpointStore.setMilestone),
// item 1's RAM-based num_ctx suggestion (hwMetrics.estimateSuggestedNumCtx),
// item 2 (agent/gamingDetection.ts — Outcome mode "cheap tricks bypass"),
// item 3 (ChatSession.forkAt — see testForkChat below), and item 5's
// agent-facing half (tools/backgroundProcessManager.ts — background commands).
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatStore, StoredSession } from '../../src/forge/chatStore';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { OllamaClient } from '../../src/ollama/client';
import { PendingEditManager } from '../../src/tools/editApply';
import { WorkspaceIndex } from '../../src/indexing/workspaceIndex';
import { ChatMemoryIndex } from '../../src/indexing/chatMemoryIndex';
import { RulesEngine } from '../../src/forge/rules';
import { SkillsEngine } from '../../src/forge/skills';
import { HookRunner } from '../../src/forge/hooks';
import { MemoryStore } from '../../src/forge/memory';
import { WebSearchService } from '../../src/websearch/searchService';
import { WebFetchService } from '../../src/websearch/fetchService';
import { WebSearchKeyStore } from '../../src/websearch/keyStore';
import { BackgroundProcessManager } from '../../src/tools/backgroundProcessManager';
import { CheckpointStore } from '../../src/agent/checkpoints';
import { deriveMilestoneSummary, renderMilestonesForPrompt } from '../../src/chat/milestones';
import { estimateSuggestedNumCtx } from '../../src/util/hwMetrics';
import { detectSuspiciousVerifyBypass } from '../../src/agent/gamingDetection';
import { UiTranscriptEntry } from '../../src/webview/protocol';
import { runCommandTool } from '../../src/tools/commandTool';
import { checkBackgroundCommandTool } from '../../src/tools/backgroundCommandTool';

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v8-test-'));
  return vscode.Uri.file(tmp);
}

function makeStoredSession(id: string, title: string): StoredSession {
  const now = new Date().toISOString();
  return { id, title, mode: 'agent', model: 'fake-model', createdAt: now, updatedAt: now, uiHistory: [], modelHistory: [] };
}

/** Same fixture-building technique as test_v7.ts's testChatViewProviderSessionOps — a real ChatViewProvider with every dependency faked/local, so forkAt() can be exercised through its actual message-handling path rather than reimplementing that plumbing in the test. */
function makeProvider() {
  const workspaceRoot = freshWorkspace();
  const chatStore = new ChatStore(workspaceRoot);
  const ollama = new OllamaClient(() => 'http://localhost:11434');
  const pendingEdits = new PendingEditManager(workspaceRoot);
  const workspaceIndex = new WorkspaceIndex(ollama, workspaceRoot, undefined, () => 'nomic-embed-text');
  const chatMemoryIndex = new ChatMemoryIndex(ollama, undefined, () => 'nomic-embed-text');
  const rules = new RulesEngine(workspaceRoot);
  const skills = new SkillsEngine(workspaceRoot);
  const hooks = new HookRunner(workspaceRoot);
  const memory = new MemoryStore(workspaceRoot);
  const webSearchService = new WebSearchService(
    () => ({ provider: 'duckduckgo', maxResults: 8, timeoutMs: 5000, cacheTtlMinutes: 10, blockedDomains: [] }),
    async () => ({})
  );
  const webFetchService = new WebFetchService(() => ({ timeoutMs: 5000, respectRobotsTxt: true, maxFetchChars: 500000, cacheTtlMinutes: 10 }));
  const fakeSecrets: any = { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) };
  const keyStore = new WebSearchKeyStore(fakeSecrets);
  const fakeContext: any = {
    subscriptions: [],
    extensionUri: workspaceRoot,
    extensionPath: workspaceRoot.fsPath,
    storageUri: workspaceRoot,
    globalStorageUri: workspaceRoot,
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
    secrets: fakeSecrets,
  };
  const provider = new ChatViewProvider(
    fakeContext,
    ollama,
    pendingEdits,
    new BackgroundProcessManager(),
    workspaceIndex,
    chatMemoryIndex,
    rules,
    skills,
    hooks,
    memory,
    chatStore,
    webSearchService,
    webFetchService,
    keyStore,
    workspaceRoot,
    'test-workspace'
  );
  const posted: any[] = [];
  (provider as any).view = { webview: { postMessage: (m: any) => posted.push(m) } };
  return { provider: provider as any, posted, workspaceRoot };
}

async function testCorruptedSessionRecovery() {
  // ---------- recovers from a leftover .tmp file when the real file is corrupt ----------
  {
    const root = freshWorkspace();
    const store = new ChatStore(root);
    const id = store.newId();
    await store.save(makeStoredSession(id, 'good title'));
    const chatDir = vscode.Uri.joinPath(root, '.forge', 'chat').fsPath;
    // Corrupt the real file...
    fs.writeFileSync(path.join(chatDir, `${id}.json`), '{ this is not valid json');
    // ...but leave a valid, slightly-different .tmp behind (simulating an
    // abandoned write from the pre-0.8.1 race this is recovering from).
    const tmpSession = makeStoredSession(id, 'recovered from tmp');
    fs.writeFileSync(path.join(chatDir, `${id}.json.tmp`), JSON.stringify(tmpSession));
    const loaded = await store.load(id);
    ok(!!loaded && loaded.title === 'recovered from tmp', `load() recovers content from a leftover .tmp file when <id>.json is corrupt (got title=${JSON.stringify(loaded?.title)})`);
    const reloaded = await store.load(id);
    ok(!!reloaded && reloaded.title === 'recovered from tmp', 'the recovered content was actually saved back — a second load() does not need to recover again');
    ok(!fs.existsSync(path.join(chatDir, `${id}.json.tmp`)), 'the leftover .tmp file is cleaned up after a successful recovery');
  }

  // ---------- falls back to a synthetic shell when there is no usable .tmp either ----------
  {
    const root = freshWorkspace();
    const store = new ChatStore(root);
    const id = store.newId();
    await store.save(makeStoredSession(id, 'original title'));
    const chatDir = vscode.Uri.joinPath(root, '.forge', 'chat').fsPath;
    fs.writeFileSync(path.join(chatDir, `${id}.json`), '{ also not valid json');
    // No .tmp file present this time.
    const loaded = await store.load(id);
    ok(!!loaded, 'a session with a corrupt file and no usable .tmp still returns a usable session (this is literally the reported "won\'t open" bug) instead of undefined');
    ok(loaded?.title === 'original title', "the synthetic shell keeps the session's known title from index.json rather than losing it entirely");
    ok(!!loaded?.uiHistory.find((e) => e.kind === 'error'), 'the synthetic shell surfaces a visible error entry explaining the data loss, rather than silently pretending nothing happened');
    // Rename and delete are the two operations the bug report says "still work" — confirm the synthetic shell doesn't break them.
    await store.rename(id, 'renamed after recovery');
    const sessions = await store.listSessions();
    ok(sessions.find((s) => s.id === id)?.title === 'renamed after recovery', 'rename() still works on a session that just went through synthetic-shell recovery');
  }

  // ---------- an id with no index entry at all is genuinely "never existed," not a recovery case ----------
  {
    const store = new ChatStore(freshWorkspace());
    const loaded = await store.load('sess_totally_made_up');
    ok(loaded === undefined, 'load() on an id with no content file and no index entry correctly returns undefined (not every miss is a corruption to recover from)');
  }
}

function toolEntry(overrides: Partial<Extract<UiTranscriptEntry, { kind: 'tool' }>>): UiTranscriptEntry {
  return { kind: 'tool', id: 'e' + Math.random(), callId: 'c1', tool: 'write_file', args: {}, status: 'done', ok: true, ...overrides };
}

function testMilestoneDerivation() {
  // ---------- files written/deleted, commands, sub-agents, verify, failures, errors all show up ----------
  {
    const entries: UiTranscriptEntry[] = [
      toolEntry({ tool: 'write_file', args: { path: 'src/a.ts' } }),
      toolEntry({ tool: 'write_file', args: { path: 'src/b.ts' } }),
      toolEntry({ tool: 'write_file', args: { path: 'src/old.ts', delete: true } }),
      toolEntry({ tool: 'run_command', args: { command: 'npm test' } }),
      { kind: 'subagent', id: 's1', task: 'refactor', status: 'done', ok: true, depth: 1 },
      { kind: 'verify', id: 'v1', command: 'npm test', status: 'done', ok: true },
    ];
    const summary = deriveMilestoneSummary(entries);
    ok(summary.includes('src/a.ts') && summary.includes('src/b.ts'), `milestone mentions written files (got: ${summary})`);
    ok(summary.includes('src/old.ts'), `milestone mentions the deleted file separately from written ones (got: ${summary})`);
    ok(/ran .*npm test/.test(summary), `milestone mentions the command that ran (got: ${summary})`);
    ok(summary.includes('1 sub-agent'), `milestone mentions the sub-agent delegation (got: ${summary})`);
    ok(summary.includes('definition-of-done passed'), `milestone mentions the verify outcome (got: ${summary})`);
  }

  // ---------- tool failures and errors are called out ----------
  {
    const entries: UiTranscriptEntry[] = [toolEntry({ tool: 'run_command', args: { command: 'exit 1' }, status: 'done', ok: false }), { kind: 'error', id: 'e1', text: 'boom' }];
    const summary = deriveMilestoneSummary(entries);
    ok(/1 tool call\(s\) failed/.test(summary), `milestone reports tool failures (got: ${summary})`);
    ok(summary.includes('turn ended in an error'), `milestone reports the terminal error (got: ${summary})`);
  }

  // ---------- a plain-text-only turn with no tool calls still gets a sensible, non-empty milestone ----------
  {
    const noTools = deriveMilestoneSummary([{ kind: 'assistant', id: 'a1', text: 'Sure, here is the answer.' }]);
    ok(noTools === 'Answered directly, no tools used.', `a text-only turn gets a specific, honest label instead of a blank string (got: ${JSON.stringify(noTools)})`);
    const nothing = deriveMilestoneSummary([]);
    ok(nothing === 'No visible action taken.', `an empty turn (e.g. aborted before anything happened) gets its own label rather than throwing or returning "" (got: ${JSON.stringify(nothing)})`);
  }

  // ---------- long file lists are summarized, not dumped in full ----------
  {
    const many: UiTranscriptEntry[] = [];
    for (let i = 0; i < 6; i++) many.push(toolEntry({ tool: 'write_file', args: { path: `src/f${i}.ts` } }));
    const summary = deriveMilestoneSummary(many);
    ok(summary.includes('3 more file'), `more than 3 written files collapses to "...and N more" instead of listing all of them (got: ${summary})`);
  }
}

function testRenderMilestonesForPrompt() {
  // ---------- no checkpoints have a milestone yet -> undefined, not an empty section ----------
  {
    const store = CheckpointStore.fromJSON([{ id: 'c1', label: 'turn 1', createdAt: new Date().toISOString(), uiHistoryIndex: 0, modelHistoryLength: 0, fileSnapshots: {} }]);
    ok(renderMilestonesForPrompt(store.list()) === undefined, 'renderMilestonesForPrompt returns undefined (not an empty/placeholder section) when nothing has a milestone yet');
  }

  // ---------- setMilestone attaches to the right checkpoint, and it round-trips through rendering ----------
  {
    const store = new CheckpointStore();
    store.begin({ id: 'c1', label: 'turn 1', createdAt: new Date().toISOString(), uiHistoryIndex: 0, modelHistoryLength: 0 });
    store.setMilestone('c1', 'Edited src/a.ts.');
    store.begin({ id: 'c2', label: 'turn 2', createdAt: new Date().toISOString(), uiHistoryIndex: 5, modelHistoryLength: 10 });
    store.setMilestone('c2', 'Ran npm test; definition-of-done passed.');
    // setMilestone on an id that no longer exists (e.g. dropped by a prior restore) must be a safe no-op, not a throw.
    store.setMilestone('does-not-exist', 'should not throw');
    const rendered = renderMilestonesForPrompt(store.list());
    ok(!!rendered && rendered.includes('Edited src/a.ts.') && rendered.includes('definition-of-done passed'), `rendered milestone block includes both turns' digests (got: ${rendered})`);
    ok(!!rendered && rendered.includes('[turn 1]') && rendered.includes('[turn 2]'), `rendered milestone block labels each line with its checkpoint label (got: ${rendered})`);
  }

  // ---------- very long milestone logs are capped, keeping the most recent ones ----------
  {
    const store = new CheckpointStore();
    for (let i = 0; i < 50; i++) {
      store.begin({ id: `c${i}`, label: `turn ${i}`, createdAt: new Date().toISOString(), uiHistoryIndex: i, modelHistoryLength: i });
      store.setMilestone(`c${i}`, `Did something in turn ${i}.`);
    }
    const rendered = renderMilestonesForPrompt(store.list())!;
    ok(rendered.includes('turn 49') && !rendered.includes('[turn 0]'), `with 50 milestones logged, the render keeps the most recent ones and drops the oldest (got tail: ${rendered.slice(-80)})`);
  }
}

function testEstimateSuggestedNumCtx() {
  ok(estimateSuggestedNumCtx(8192, { usedGB: 30, totalGB: 32 }) === undefined, 'a nearly-full machine (idle RAM well under the 2GB/20% floor) gets no suggestion at all, rather than a noisy tiny bump');
  ok(estimateSuggestedNumCtx(8192, { usedGB: 8, totalGB: 32 }) !== undefined, 'a machine with substantial idle RAM (24/32GB free) does get a suggestion');
  const suggestion = estimateSuggestedNumCtx(8192, { usedGB: 8, totalGB: 32 })!;
  ok(suggestion > 8192, `the suggestion is strictly larger than the current num_ctx (got ${suggestion})`);
  ok(suggestion % 1024 === 0, `the suggestion is rounded to a "nice" multiple of 1024 rather than an arbitrary float (got ${suggestion})`);
  ok(suggestion <= 131072, `the suggestion is capped at a sane ceiling regardless of how much RAM is idle (got ${suggestion})`);
  ok(estimateSuggestedNumCtx(0, { usedGB: 1, totalGB: 32 }) === undefined, 'a zero/unset current num_ctx produces no suggestion instead of NaN or a bogus scale-up');
  // An absurd amount of idle RAM must still be capped, not extrapolated forever.
  const huge = estimateSuggestedNumCtx(100000, { usedGB: 2, totalGB: 512 });
  ok(huge === 131072, `even with enormous idle RAM, the suggestion never exceeds the hard cap (got ${huge})`);
}

function testDetectSuspiciousVerifyBypass() {
  // ---------- a genuine fix (no suspicious patterns) is not flagged ----------
  {
    const writes = [{ path: 'src/math.ts', text: 'export function add(a: number, b: number) { return a + b; } // was a - b, fixed the actual bug' }];
    const findings = detectSuspiciousVerifyBypass(writes, 'npm test');
    ok(findings.length === 0, `a genuine source fix with no gaming patterns is not flagged (got ${JSON.stringify(findings)})`);
  }

  // ---------- skipping the failing test is flagged ----------
  {
    const writes = [{ path: 'src/math.test.ts', text: "it.skip('adds two numbers', () => { expect(add(1,2)).toBe(3); });" }];
    const findings = detectSuspiciousVerifyBypass(writes, 'npm test');
    ok(findings.length === 1 && findings[0].path === 'src/math.test.ts', `marking a test .skip(...) is flagged against the file that changed (got ${JSON.stringify(findings)})`);
  }

  // ---------- xit/xdescribe, .only, and disable annotations are all flagged ----------
  {
    ok(detectSuspiciousVerifyBypass([{ path: 'a.test.ts', text: "xit('does the thing', () => {})" }], 'npm test').length === 1, 'xit(...) is flagged');
    ok(detectSuspiciousVerifyBypass([{ path: 'a.test.ts', text: "describe.only('just this one', () => {})" }], 'npm test').length === 1, '.only(...) is flagged');
    ok(detectSuspiciousVerifyBypass([{ path: 'test_a.py', text: '@pytest.mark.skip\ndef test_a(): assert False' }], 'pytest').length === 1, '@pytest.mark.skip is flagged');
  }

  // ---------- neutered/tautological assertions and swallowed errors are flagged ----------
  {
    ok(detectSuspiciousVerifyBypass([{ path: 'a.test.ts', text: 'expect(true).toBe(true);' }], 'npm test').length === 1, 'expect(true).toBe(true) tautology is flagged');
    ok(detectSuspiciousVerifyBypass([{ path: 'a_test.py', text: 'assert True' }], 'pytest').length === 1, 'assert True tautology is flagged');
    ok(detectSuspiciousVerifyBypass([{ path: 'a.ts', text: 'try { risky(); } catch (e) {}' }], 'npm test').length === 1, 'an empty catch block silently swallowing an error is flagged');
    ok(detectSuspiciousVerifyBypass([{ path: 'a.py', text: 'try:\n    risky()\nexcept:\n    pass' }], 'pytest').length === 1, 'a bare except:pass silently swallowing an error is flagged');
  }

  // ---------- commenting out an assertion instead of fixing it is flagged ----------
  {
    ok(detectSuspiciousVerifyBypass([{ path: 'a.test.ts', text: '// expect(result).toBe(42);' }], 'npm test').length === 1, 'a commented-out expect(...) is flagged');
  }

  // ---------- editing the verify command's own script directly is flagged even with unremarkable content ----------
  {
    const writes = [{ path: 'scripts/check.sh', text: '#!/bin/bash\necho "all good"\nexit 0' }];
    const findings = detectSuspiciousVerifyBypass(writes, './scripts/check.sh');
    ok(findings.length === 1 && /own script/.test(findings[0].reason), `editing the exact file the verify command runs is flagged regardless of content (got ${JSON.stringify(findings)})`);
  }

  // ---------- multiple distinct suspicious files each get their own finding, but only one per file ----------
  {
    const writes = [
      { path: 'a.test.ts', text: "it.skip('x', () => {}); it.skip('y', () => {});" }, // two skips in ONE file
      { path: 'b.test.ts', text: 'expect(true).toBe(true);' },
    ];
    const findings = detectSuspiciousVerifyBypass(writes, 'npm test');
    ok(findings.length === 2, `two separately-edited suspicious files each get exactly one finding, not one per matched pattern (got ${findings.length})`);
  }
}

async function testForkChat() {
  const { provider: p, posted, workspaceRoot } = makeProvider();

  await p.newChat();
  const originalId = p.activeSessionId;
  const session = p.sessions.get(originalId);
  session.title = 'Refactor the parser';

  const fileUri = vscode.Uri.joinPath(workspaceRoot, 'src', 'greet.ts');
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, 'src'));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from('export const greeting = "hello";', 'utf8'));

  // Turn 1: begin a checkpoint exactly the way ChatSession.send() does (see
  // chatSession.ts — begin() is called with the uiHistory length captured
  // BEFORE this turn's user message is pushed), edit the tracked file, and
  // attach a milestone.
  const cpId = 'cp_fork_test';
  session.checkpoints.begin({ id: cpId, label: 'turn 1', createdAt: new Date().toISOString(), uiHistoryIndex: session.uiHistory.length, modelHistoryLength: session.modelHistory.length });
  session.uiHistory.push({ kind: 'user', id: 'u1', text: 'change the greeting', checkpointId: cpId });
  session.checkpoints.recordBeforeWrite('src/greet.ts', 'export const greeting = "hello";');
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from('export const greeting = "hi";', 'utf8'));
  session.uiHistory.push({ kind: 'assistant', id: 'a1', text: 'Changed it to hi.' });
  session.modelHistory.push({ role: 'user', content: 'change the greeting' });
  session.modelHistory.push({ role: 'assistant', content: 'Changed it to hi.' });
  session.checkpoints.setMilestone(cpId, 'Edited src/greet.ts.');

  // Turn 2, AFTER the checkpoint we're about to fork from — this must NOT
  // show up in the fork, and must NOT be affected by forking either.
  session.uiHistory.push({ kind: 'user', id: 'u2', text: 'change it again' });
  session.uiHistory.push({ kind: 'assistant', id: 'a2', text: 'Changed it to hey.' });
  session.modelHistory.push({ role: 'user', content: 'change it again' });
  session.modelHistory.push({ role: 'assistant', content: 'Changed it to hey.' });
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from('export const greeting = "hey";', 'utf8'));

  const beforeUiLen = session.uiHistory.length;
  const beforeCheckpointsLen = session.checkpoints.list().length;
  const beforeModelLen = session.modelHistory.length;

  posted.length = 0;
  await p.handleMessage({ type: 'forkChat', id: cpId });

  // ---------- the original session is completely untouched ----------
  ok(session.uiHistory.length === beforeUiLen, `forking does not truncate the ORIGINAL session's uiHistory (got ${session.uiHistory.length}, expected ${beforeUiLen})`);
  ok(session.checkpoints.list().length === beforeCheckpointsLen, `forking does not touch the ORIGINAL session's checkpoint list (got ${session.checkpoints.list().length}, expected ${beforeCheckpointsLen})`);
  ok(session.modelHistory.length === beforeModelLen, `forking does not touch the ORIGINAL session's modelHistory (got ${session.modelHistory.length}, expected ${beforeModelLen})`);
  ok(p.sessions.has(originalId), 'the original session is still registered in the provider after forking (fork does not close/replace it)');

  // ---------- a genuinely new session was created and switched to ----------
  const chatForkedMsg = posted.find((m) => m.type === 'chatForked');
  ok(!!chatForkedMsg && chatForkedMsg.ok === true, `a successful chatForked confirmation was posted (got ${JSON.stringify(chatForkedMsg)})`);
  ok(p.activeSessionId !== originalId, 'the active session switched away from the original to the new fork');
  const forkedId = p.activeSessionId;
  const forked = p.sessions.get(forkedId);
  ok(!!forked, 'the forked session is registered in provider.sessions under its own new id');
  ok(forked.title.includes('Refactor the parser') && forked.title.includes('fork'), `the forked session's title references the original title and marks it as a fork (got ${JSON.stringify(forked?.title)})`);

  // ---------- the fork's history is truncated to exactly what restoreCheckpoint(cpId) would have left, not turn 2 ----------
  ok(!forked.uiHistory.some((e: any) => e.id === 'u2' || e.id === 'a2'), "the fork's history excludes turn 2, which came after the forked-from checkpoint");
  ok(!forked.uiHistory.some((e: any) => e.id === 'u1' || e.id === 'a1'), "the fork's history also excludes the checkpoint's OWN turn — forking at a checkpoint means \"branch from right before this message,\" matching restoreCheckpoint's own semantics");
  ok(forked.uiHistory.some((e: any) => e.kind === 'system' && /[Ff]orked from/.test(e.text)), "the fork carries a visible note explaining where it came from, for when you're looking at it later out of context");
  ok(forked.checkpoints.list().some((c: any) => c.id === cpId), "the fork's checkpoint list includes the checkpoint it was forked from");
  ok(forked.modelHistory.length === 0, "the fork's modelHistory is truncated to match (nothing from either turn, since the checkpoint predates both)");

  // ---------- the fork does NOT share object references with the original (deep clone) ----------
  ok(forked.uiHistory !== session.uiHistory, 'forked.uiHistory is a genuinely separate array, not the same reference as the original');
  ok(forked.checkpoints !== session.checkpoints, 'forked.checkpoints is a genuinely separate CheckpointStore instance, not the same reference as the original');

  // ---------- the checkpoint's file reversion was actually applied to the shared workspace ----------
  const diskContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
  ok(diskContent === 'export const greeting = "hello";', `forking reverted the shared workspace file to the checkpoint's recorded prior content, same as restoreCheckpoint would (got ${JSON.stringify(diskContent)}) — this is the documented shared-workspace tradeoff (see forkAt's doc comment): the ORIGINAL chat's tab now also sees this reverted content on disk until it writes again`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testBackgroundProcessManager() {
  // ---------- a quick-exiting command is tracked from "running" to "exited" with its output ----------
  {
    const mgr = new BackgroundProcessManager();
    const started = mgr.start('echo hello-from-bg', process.cwd());
    ok(started.ok === true, `starting a simple background command succeeds (got ${JSON.stringify(started)})`);
    if (!started.ok) return;
    const immediate = mgr.check(started.id);
    ok(immediate.found === true, 'the just-started process is immediately findable by its id');
    // Poll briefly for it to finish — `echo` exits almost instantly, but this avoids a flaky race against the child process's own event loop turn.
    let final = mgr.check(started.id);
    for (let i = 0; i < 20 && final.found && final.status === 'running'; i++) {
      await sleep(25);
      final = mgr.check(started.id);
    }
    ok(final.found === true && final.status === 'exited', `a quick command eventually reports exited (got ${JSON.stringify(final)})`);
    if (final.found) {
      ok(final.exitCode === 0, `a successful command's exit code is captured (got ${final.exitCode})`);
      ok(final.output.includes('hello-from-bg'), `stdout is captured in output (got ${JSON.stringify(final.output)})`);
    }
    ok(mgr.list().some((p) => p.id === started.id), "list() includes the process by id");
  }

  // ---------- checking/killing an unknown id reports found:false instead of throwing ----------
  {
    const mgr = new BackgroundProcessManager();
    ok(mgr.check('bg_does_not_exist').found === false, 'check() on an unknown id reports found:false');
    ok(mgr.kill('bg_does_not_exist').found === false, 'kill() on an unknown id reports found:false');
  }

  // ---------- kill() actually stops a long-running process, and is idempotent afterward ----------
  {
    const mgr = new BackgroundProcessManager();
    const started = mgr.start('sleep 30', process.cwd());
    if (!started.ok) { ok(false, `expected sleep 30 to start (got ${JSON.stringify(started)})`); return; }
    await sleep(50);
    ok(mgr.check(started.id).status === 'running', 'sanity: the long-running command is still running before kill()');
    const killed = mgr.kill(started.id);
    ok(killed.found === true && killed.alreadyExited === false, `kill() reports it actually killed a running process (got ${JSON.stringify(killed)})`);
    let final = mgr.check(started.id);
    for (let i = 0; i < 20 && final.found && final.status === 'running'; i++) {
      await sleep(25);
      final = mgr.check(started.id);
    }
    ok(final.found === true && final.status === 'exited', 'the killed process is reflected as exited shortly after');
    const killAgain = mgr.kill(started.id);
    ok(killAgain.found === true && killAgain.alreadyExited === true, 'killing an already-exited process is a safe, idempotent no-op that reports alreadyExited');
  }

  // ---------- the concurrent-running cap refuses a new start once at the limit ----------
  {
    const mgr = new BackgroundProcessManager();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const started = mgr.start('sleep 30', process.cwd());
      ok(started.ok === true, `background command #${i + 1} of 5 starts successfully`);
      if (started.ok) ids.push(started.id);
    }
    const sixth = mgr.start('sleep 30', process.cwd());
    ok(sixth.ok === false, `a 6th concurrently-running background command is refused once the cap is hit (got ${JSON.stringify(sixth)})`);
    // Free a slot and confirm a new one is accepted again.
    mgr.kill(ids[0]);
    let freed = mgr.check(ids[0]);
    for (let i = 0; i < 20 && freed.found && freed.status === 'running'; i++) {
      await sleep(25);
      freed = mgr.check(ids[0]);
    }
    const afterFree = mgr.start('sleep 30', process.cwd());
    ok(afterFree.ok === true, 'killing one running process frees a slot for a new background command to start');
    for (const id of ids.slice(1)) mgr.kill(id);
    if (afterFree.ok) mgr.kill(afterFree.id);
  }
}

function fakeToolCtx(mgr: BackgroundProcessManager, workspaceRoot: string): any {
  return {
    workspaceRoot: vscode.Uri.file(workspaceRoot),
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    requestCommandApproval: async () => true,
    startBackgroundCommand: (command: string, cwd: string) => mgr.start(command, cwd),
    checkBackgroundCommand: (id: string) => mgr.check(id),
    killBackgroundCommand: (id: string) => mgr.kill(id),
    listBackgroundCommands: () => mgr.list(),
  };
}

async function testBackgroundToolIntegration() {
  const workspaceRoot = freshWorkspace().fsPath;
  const mgr = new BackgroundProcessManager();
  const ctx = fakeToolCtx(mgr, workspaceRoot);

  // ---------- run_command with {"background": true} returns immediately with a handle, instead of waiting for exit ----------
  {
    const start = Date.now();
    const result = await runCommandTool({ command: 'sleep 5', background: true }, ctx);
    const elapsedMs = Date.now() - start;
    ok(result.ok === true, `run_command with background:true reports ok immediately (got ${JSON.stringify(result)})`);
    ok(elapsedMs < 2000, `run_command with background:true returns right away rather than waiting out the command (took ${elapsedMs}ms for a 5s sleep)`);
    const idMatch = result.content.match(/"(bg_[a-z0-9_]+)"/);
    ok(!!idMatch, `the tool result includes the background process's id so it can be checked later (got ${JSON.stringify(result.content)})`);
    if (idMatch) {
      const status = await checkBackgroundCommandTool({ id: idMatch[1] }, ctx);
      ok(status.ok === true && /still running|status: running/.test(status.content), `check_background_command finds it still running right after starting (got ${JSON.stringify(status)})`);
      mgr.kill(idMatch[1]);
    }
  }

  // ---------- check_background_command's "list" action works with no id ----------
  {
    const empty = await checkBackgroundCommandTool({ action: 'list' }, fakeToolCtx(new BackgroundProcessManager(), workspaceRoot));
    ok(empty.ok === true && /[Nn]o background commands/.test(empty.content), `"list" on a fresh manager reports none started, rather than erroring for lack of an id (got ${JSON.stringify(empty)})`);
    const withOne = await checkBackgroundCommandTool({ action: 'list' }, ctx);
    ok(withOne.content.includes('sleep 5'), `"list" includes previously-started commands (got ${JSON.stringify(withOne.content)})`);
  }

  // ---------- checking/killing an unknown id via the tool gives a clear error, not a crash ----------
  {
    const missing = await checkBackgroundCommandTool({ id: 'bg_totally_made_up' }, ctx);
    ok(missing.ok === false && /No background command/.test(missing.content), `checking an unknown id fails cleanly with a clear message (got ${JSON.stringify(missing)})`);
    const missingKill = await checkBackgroundCommandTool({ id: 'bg_totally_made_up', action: 'kill' }, ctx);
    ok(missingKill.ok === false, 'killing an unknown id also fails cleanly rather than throwing');
  }

  // ---------- the 5-concurrent cap surfaces through run_command as a clear tool error, not a silent hang ----------
  {
    const fullMgr = new BackgroundProcessManager();
    const fullCtx = fakeToolCtx(fullMgr, workspaceRoot);
    const startedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await runCommandTool({ command: 'sleep 30', background: true }, fullCtx);
      const m = r.content.match(/"(bg_[a-z0-9_]+)"/);
      if (m) startedIds.push(m[1]);
    }
    const sixth = await runCommandTool({ command: 'sleep 30', background: true }, fullCtx);
    ok(sixth.ok === false && /already running/.test(sixth.content), `the cap is enforced end-to-end through run_command, not just at the manager level (got ${JSON.stringify(sixth)})`);
    for (const id of startedIds) fullMgr.kill(id);
  }
}

async function main() {
  await testCorruptedSessionRecovery();
  testMilestoneDerivation();
  testRenderMilestonesForPrompt();
  testEstimateSuggestedNumCtx();
  testDetectSuspiciousVerifyBypass();
  await testForkChat();
  await testBackgroundProcessManager();
  await testBackgroundToolIntegration();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('SOME v0.9.0 TESTS FAILED');
    process.exit(1);
  }
  console.log('All v0.9.0 (milestone logging, num_ctx suggestion, corrupted-chat recovery) runtime tests passed.');
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
