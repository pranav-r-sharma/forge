// Runtime tests for the 0.10.0 round — the big backlog-plus-architecture
// pass: mode-indicator staleness (item 3), the stop-button-freezes-the-chat
// bug (items 5/8/9, two independent halves — commandTool.ts's process
// termination and agentLoop.ts's tool-execution safety net), progress
// indicators (item 4), file-reference links not opening (item 7), the
// loop-detection on/off toggle + check_background_command exemption
// (item 9/10), whitespace/indentation drift on targeted writes (item 10/11),
// per-chat model overrides (item 12/13), and the unified memory + project-log
// architecture (items 6/13 + the documentation-skill request). Each section
// below is independently runnable and mirrors the ok()/main() harness used
// by every previous test_v*.ts file in this directory.
//
// Note: several of the commandTool.ts and agentLoop.ts tests below
// deliberately wait out real timers (the 2s SIGTERM->SIGKILL escalation
// grace period, the 4s TOOL_ABORT_GRACE_MS) rather than mocking time, since
// the whole point of this round's fix is real wall-clock behavior under a
// real child process — a mocked clock would not have caught the original bug.
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runCommandTool } from '../../src/tools/commandTool';
import { checkLoop, raceToolCallWithCancellation, TOOL_ABORT_GRACE_MS } from '../../src/agent/agentLoop';
import { LoopDetector } from '../../src/agent/loopDetector';
import { getConfig, setForgeSetting } from '../../src/util/config';
import { MemoryStore, overlapScore } from '../../src/forge/memory';
import { ChatStore } from '../../src/forge/chatStore';
import { writeFileTool, dominantIndentChar, detectIndentMismatch } from '../../src/tools/fileTools';
import { buildSystemPrompt, buildTurnContextPrefix } from '../../src/agent/systemPrompt';
import { ChatSession } from '../../src/chat/chatSession';
import { PendingEditManager } from '../../src/tools/editApply';
import { BackgroundProcessManager } from '../../src/tools/backgroundProcessManager';
import { ToolResult } from '../../src/agent/types';

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

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v10-test-'));
  return vscode.Uri.file(tmp);
}

// ---------- commandTool.ts: stop-button-freeze fix, process side ----------

async function testCancellationKillsWellBehavedCommandQuickly() {
  const cts = new vs.CancellationTokenSource();
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    cancellation: cts.token,
    requestCommandApproval: async () => true,
  };
  const start = Date.now();
  const resultPromise = runCommandTool({ command: 'sleep 30' }, ctx);
  setTimeout(() => cts.cancel(), 200);
  const result = await resultPromise;
  const elapsed = Date.now() - start;
  ok(result.ok === false, 'a cancelled command reports ok:false');
  ok(elapsed < 1800, `a well-behaved command dies from plain SIGTERM quickly, without needing the ~2s SIGKILL escalation (took ${elapsed}ms)`);
  ok(/Stop was requested/.test(result.content), `result content explains the command was stopped by the user (got ${JSON.stringify(result.content)})`);
}

async function testSigtermIgnoredEscalatesToSigkill() {
  const cts = new vs.CancellationTokenSource();
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    cancellation: cts.token,
    requestCommandApproval: async () => true,
  };
  const start = Date.now();
  // `exec` replaces the shell's own process image with `sleep`, so the
  // SIG_IGN disposition set by `trap` (which persists across exec) actually
  // applies to the long-running process itself, not just a shell wrapper
  // that would otherwise still die normally on SIGTERM.
  const resultPromise = runCommandTool({ command: "trap '' TERM; exec sleep 30" }, ctx);
  setTimeout(() => cts.cancel(), 200);
  const result = await resultPromise;
  const elapsed = Date.now() - start;
  ok(result.ok === false, 'a force-killed command reports ok:false');
  ok(
    elapsed >= 1900 && elapsed < 6000,
    `a command that ignores SIGTERM is escalated to SIGKILL after the ~2s grace period rather than hanging forever — this is the actual fix for "stop works but freezes the chat" (took ${elapsed}ms)`
  );
  ok(/force-killed/.test(result.content), `result content notes it had to be force-killed after ignoring the stop signal (got ${JSON.stringify(result.content)})`);
}

async function testTimeoutAlsoEscalatesThroughSameMechanism() {
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    requestCommandApproval: async () => true,
  };
  const start = Date.now();
  const result = await runCommandTool({ command: "trap '' TERM; exec sleep 30", timeout_ms: 300 }, ctx);
  const elapsed = Date.now() - start;
  ok(result.ok === false, 'a command that hits its own configured timeout and ignores SIGTERM still resolves as failed, not hanging');
  ok(
    elapsed >= 300 && elapsed < 4000,
    `resolves once the timeout elapses and the SIGKILL escalation grace period runs out, not sooner and not never (took ${elapsed}ms)`
  );
  ok(
    /timeout/.test(result.content) && /force-killed/.test(result.content),
    `result content explains both that it hit the timeout AND that it had to be force-killed — the timeout path and the Stop path now share one escalation mechanism (got ${JSON.stringify(result.content)})`
  );
}

async function testOrdinaryCommandStillWorksNormally() {
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
    requestCommandApproval: async () => true,
  };
  const result = await runCommandTool({ command: 'echo hello-forge-v10' }, ctx);
  ok(result.ok === true && result.content.includes('hello-forge-v10'), `an ordinary quick command is unaffected by the detached/escalation rework (got ${JSON.stringify(result.content)})`);
}

// ---------- agentLoop.ts: stop-button-freeze fix, tool-execution safety net ----------

async function testRaceToolCallRealResultWinsWhenNotCancelled() {
  const cts = new vs.CancellationTokenSource();
  const real: Promise<ToolResult> = Promise.resolve({ ok: true, content: 'done' });
  const result = await raceToolCallWithCancellation(real, cts.token);
  ok(result.ok === true && result.content === 'done', 'a tool call that settles normally passes straight through the race wrapper unaffected');
}

async function testRaceToolCallAbortsAfterGracePeriod() {
  const cts = new vs.CancellationTokenSource();
  const neverResolves: Promise<ToolResult> = new Promise(() => {});
  const start = Date.now();
  const resultPromise = raceToolCallWithCancellation(neverResolves, cts.token);
  setTimeout(() => cts.cancel(), 100);
  const result = await resultPromise;
  const elapsed = Date.now() - start;
  ok(result.ok === false, 'a tool call that never settles is treated as aborted rather than blocking the turn forever');
  ok(
    elapsed >= TOOL_ABORT_GRACE_MS - 50 && elapsed < TOOL_ABORT_GRACE_MS + 2000,
    `resolves roughly ${TOOL_ABORT_GRACE_MS}ms after cancellation fires, not immediately and not never (took ${elapsed}ms) — this is the backstop for "stop works but freezes the chat" when a tool call genuinely never settles`
  );
  ok(/aborted after Stop was requested/.test(result.content), `result content explains the abort (got ${JSON.stringify(result.content)})`);
}

async function testRaceToolCallAlreadyCancelledStillWaitsGracePeriod() {
  const cts = new vs.CancellationTokenSource();
  cts.cancel();
  const neverResolves: Promise<ToolResult> = new Promise(() => {});
  const start = Date.now();
  const result = await raceToolCallWithCancellation(neverResolves, cts.token);
  const elapsed = Date.now() - start;
  ok(result.ok === false, 'a token that was ALREADY cancelled before the call still eventually resolves via the grace timer');
  ok(elapsed >= TOOL_ABORT_GRACE_MS - 50, `waits out the full grace period even when cancellation predates the call (took ${elapsed}ms)`);
}

// ---------- agentLoop.ts: loop-detection toggle + check_background_command exemption ----------

function testCheckLoopExemptsBackgroundCommandUnconditionally() {
  vs.__resetConfig();
  const detector = new LoopDetector();
  const events: any[] = [];
  const emit = (e: any) => events.push(e);
  for (let i = 0; i < 10; i++) {
    const stopped = checkLoop(detector, 'check_background_command', { id: 'bg_1' }, true, 'still running', emit);
    ok(stopped === false, `check_background_command poll #${i + 1} of 10 (identical args/result) is never flagged as a loop`);
  }
  ok(events.length === 0, 'polling a background command never emits a loop-detected error, no matter how repetitive it looks — that repetition is the whole point of the feature');
}

function testCheckLoopOnByDefaultAndCatchesRepetition() {
  vs.__resetConfig();
  const detector = new LoopDetector();
  const events: any[] = [];
  const emit = (e: any) => events.push(e);
  let stopped = false;
  let warnCount = 0;
  for (let i = 0; i < 6 && !stopped; i++) {
    stopped = checkLoop(detector, 'read_file', { path: 'a.ts' }, true, 'same content every time', emit, {
      pushLoopWarning: () => warnCount++,
    });
  }
  ok(warnCount === 1, 'first loop trip emits one targeted warning instead of stopping immediately');
  ok(stopped === true, 'loop detection is ON by default and still hard-stops after the warning is ignored');
  ok(events.some((e) => e.type === 'final' && /loop/i.test(e.text)), 'a loop-detected final was emitted with an explanatory message');
  ok(events.some((e) => e.type === 'done'), 'a done event follows the loop-detected final, ending the turn');
}

function testCheckLoopCanBeDisabledViaSetting() {
  vs.__resetConfig();
  vs.__setConfig({ 'forge.loopDetection.enabled': false });
  const detector = new LoopDetector();
  const events: any[] = [];
  const emit = (e: any) => events.push(e);
  let stopped = false;
  for (let i = 0; i < 12 && !stopped; i++) {
    stopped = checkLoop(detector, 'read_file', { path: 'a.ts' }, true, 'same content every time', emit);
  }
  ok(stopped === false, 'with forge.loopDetection.enabled turned off, even a genuinely repeated identical call is never flagged');
  ok(events.length === 0, 'no error/done events are emitted while loop detection is disabled');
  vs.__resetConfig();
}

function testConfigExposesLoopDetectionEnabled() {
  vs.__resetConfig();
  ok(getConfig().loopDetectionEnabled === true, 'getConfig().loopDetectionEnabled defaults to true when forge.loopDetection.enabled is unset');
  vs.__setConfig({ 'forge.loopDetection.enabled': false });
  ok(getConfig().loopDetectionEnabled === false, 'getConfig().loopDetectionEnabled reflects an explicit false setting');
  vs.__resetConfig();
}

async function testSettingsPanelCanWriteLoopDetection() {
  vs.__resetConfig();
  const applied = await setForgeSetting('loopDetection.enabled', false);
  ok(applied === true, 'loopDetection.enabled is in the Settings panel\'s write-allowlist (SETTINGS_PANEL_KEYS)');
  ok(getConfig().loopDetectionEnabled === false, 'writing it through setForgeSetting actually takes effect');
  const rejected = await setForgeSetting('notARealSetting', true);
  ok(rejected === false, 'an unknown key is still rejected — the allowlist addition did not loosen the general guard');
  vs.__resetConfig();
}

// ---------- forge/memory.ts: relevance-based renderForPrompt + compact() ----------

async function testMemoryRenderForPromptFallsBackToRecencyWithNoQuery() {
  const root = freshWorkspace();
  const memory = new MemoryStore(root);
  await memory.addFact('The staging database credentials for the payment gateway module live in .env.staging');
  for (let i = 0; i < 60; i++) {
    await memory.addFact(`Filler note #${i}: this project uses pnpm workspaces and an eslint flat config for linting consistently.`);
  }
  const rendered = await memory.renderForPrompt();
  ok(!rendered.includes('payment gateway'), 'with no query, the oldest fact is dropped by plain recency-based truncation once the fact list overflows the render cap');
  ok(/older fact\(s\) omitted/.test(rendered), 'the omission is explicitly noted rather than silently dropped');
}

async function testMemoryRenderForPromptUsesRelevanceWhenQueryGiven() {
  const root = freshWorkspace();
  const memory = new MemoryStore(root);
  await memory.addFact('The staging database credentials for the payment gateway module live in .env.staging');
  for (let i = 0; i < 60; i++) {
    await memory.addFact(`Filler note #${i}: this project uses pnpm workspaces and an eslint flat config for linting consistently.`);
  }
  const rendered = await memory.renderForPrompt('what are the payment gateway staging database credentials again');
  ok(rendered.includes('payment gateway'), 'given a relevant query, the oldest-but-relevant fact survives the cut even though dozens of newer facts exist');
  ok(/less-relevant fact\(s\) omitted/.test(rendered), 'the relevance-based omission note is distinct from the plain recency one');
}

function testOverlapScore() {
  ok(overlapScore(new Set(['foo', 'bar']), new Set(['bar', 'baz'])) === 1, 'overlapScore counts exactly the shared tokens between two sets');
  ok(overlapScore(new Set(), new Set(['a'])) === 0, 'overlapScore is 0 when one set is empty');
}

async function testMemoryCompactArchivesUncheckedFacts() {
  const root = freshWorkspace();
  const memory = new MemoryStore(root);
  await memory.addFact('fact one, keep this');
  await memory.addFact('fact two, drop this');
  await memory.addFact('fact three, keep this too');
  const result = await memory.compact(['fact one, keep this', 'fact three, keep this too']);
  ok(result.archived === 1, `compact() reports exactly 1 archived fact (got ${result.archived})`);
  const remaining = await memory.listFacts();
  ok(remaining.length === 2 && !remaining.some((f) => f.includes('drop this')), 'the dropped fact no longer appears in memory.md');
  const archivePath = vscode.Uri.joinPath(root, '.forge', 'memory.archive.md').fsPath;
  const archiveText = fs.readFileSync(archivePath, 'utf8');
  ok(archiveText.includes('drop this'), 'the dropped fact is preserved in memory.archive.md rather than being permanently deleted');
  ok(/## Compacted/.test(archiveText), 'the archive entry is timestamped under a "## Compacted" heading');
}

async function testMemoryCompactNoOpWhenNothingUnchecked() {
  const root = freshWorkspace();
  const memory = new MemoryStore(root);
  await memory.addFact('the only fact');
  const result = await memory.compact(['the only fact']);
  ok(result.archived === 0, 'compact() with every fact kept archives nothing');
}

// ---------- forge/chatStore.ts: unified project log ----------

async function testProjectLogAppendAndRead() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  await store.appendProjectLog('Chat A', 'Fixed the login bug.');
  await store.appendProjectLog('Chat B', 'Added the export feature.');
  const rendered = await store.readProjectLogForPrompt();
  ok(rendered.includes('Chat A') && rendered.includes('Fixed the login bug.'), 'the project log includes an entry from one chat');
  ok(rendered.includes('Chat B') && rendered.includes('Added the export feature.'), 'and an entry from a completely different chat — this is what makes it cross-chat context, not per-session milestones again');
  ok(rendered.startsWith('## Project log'), 'the rendered block carries an explanatory header');
}

async function testProjectLogEmptyWhenNeverWritten() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const rendered = await store.readProjectLogForPrompt();
  ok(rendered === '', 'a workspace with no project log yet renders to an empty string, not an error or a header with no content');
}

async function testProjectLogCapsToMostRecentEntries() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  for (let i = 0; i < 30; i++) {
    await store.appendProjectLog('Chat', `Entry number ${i} with some padding text to take up space in the log file.`);
  }
  const rendered = await store.readProjectLogForPrompt(500);
  ok(rendered.includes('Entry number 29'), 'the most recent entry survives a tight character cap');
  ok(!rendered.includes('Entry number 0 '), 'the oldest entry is dropped once the cap is exceeded');
  ok(/earlier entries omitted/.test(rendered), 'the omission is explicitly noted');
}

// ---------- tools/fileTools.ts: whitespace/indentation advisory ----------

function testDominantIndentChar() {
  ok(dominantIndentChar('\tfoo\n\tbar\n\tbaz') === 'tab', 'a file whose lines mostly start with a tab is detected as tab-indented');
  ok(dominantIndentChar('  foo\n  bar\n  baz') === 'space', 'a file whose lines mostly start with spaces is detected as space-indented');
  ok(dominantIndentChar('foo\nbar') === 'none', 'text with no indented lines at all is reported as "none" (can\'t tell), not a false mismatch');
}

function testDetectIndentMismatch() {
  const tabFile = '\tfunction foo() {\n\t\treturn 1;\n\t}';
  const spaceReplace = '  function bar() {\n    return 2;\n  }';
  const tabReplace = '\tfunction bar() {\n\t\treturn 2;\n\t}';
  ok(!!detectIndentMismatch(tabFile, spaceReplace), 'a tab-indented file with a space-indented replacement is flagged');
  ok(!detectIndentMismatch(tabFile, tabReplace), 'a tab-indented file with a matching tab-indented replacement is not flagged');
  ok(!detectIndentMismatch(tabFile, 'return 2;'), 'a replacement with no indentation of its own (can\'t tell) is not flagged as a mismatch');
}

// NOTE (0.12.0): this test used to be testWriteFileToolSurfacesIndentAdvisory
// and asserted 0.10.0's advisory-only behavior — a tabs/spaces mismatch here
// was merely flagged with a "Heads up" note while the mismatched indentation
// still landed on disk as-is. 0.12.0 replaces that with a real fix
// (reindentReplacement() in fileTools.ts): a confidently-interpretable
// mismatch like this one (a single, internally-consistent line) is now
// actually remapped onto the file's tab-indented scheme before writing, and
// the tool result notes that it did so instead of just warning. Updated in
// place to match rather than left asserting the stale behavior — see
// test_v12_indent.ts for the new reindentation behavior's dedicated coverage.
async function testWriteFileToolAutoFixesIndentMismatch() {
  const existing = '\tfunction foo() {\n\t\treturn 1;\n\t}\n';
  let written: any;
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    readEffective: async () => existing,
    proposeEdit: async (edit: any) => { written = edit; return { id: 'e1', applied: true }; },
  };
  const result = await writeFileTool(
    { path: 'foo.ts', search: '\t\treturn 1;', replace: '        return 2;' },
    ctx
  );
  ok(result.ok === true, 'the edit still succeeds');
  ok(!!written && written.newText === '\tfunction foo() {\n\t\treturn 2;\n\t}\n', `the space-indented "replace" was actually remapped onto the file's tab indentation before writing, not left mismatched on disk (got ${JSON.stringify(written?.newText)})`);
  ok(!/Heads up/.test(result.content), 'the old advisory-only "Heads up" wording no longer appears once the mismatch was actually fixed');
  ok(/Note:.*automatically remapped/.test(result.content), `the tool result instead notes that the indentation was automatically fixed (got ${JSON.stringify(result.content)})`);
}

async function testWriteFileToolNoAdvisoryWhenIndentMatches() {
  const existing = '\tfunction foo() {\n\t\treturn 1;\n\t}\n';
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(process.cwd()),
    readEffective: async () => existing,
    proposeEdit: async (edit: any) => ({ id: 'e1', applied: true }),
  };
  const result = await writeFileTool(
    { path: 'foo.ts', search: '\t\treturn 1;', replace: '\t\treturn 2;' },
    ctx
  );
  ok(!/Heads up/.test(result.content), 'no advisory appears when the replacement indentation actually matches the file');
}

// ---------- agent/systemPrompt.ts: project log section + whitespace wording ----------
//
// NOTE (0.11.0): projectLogText/memoryText/milestonesText moved OUT of
// buildSystemPrompt() and into buildTurnContextPrefix() as part of the
// prompt-prefix-stability fix (see systemPrompt.ts's doc comment) — this
// test was updated in place to match rather than left asserting stale
// 0.10.0 behavior. buildSystemPrompt() itself never mentions the project log
// at all anymore; that's intentional, not a regression.

function testSystemPromptIncludesProjectLogWhenProvided() {
  const prefix = buildTurnContextPrefix({ projectLogText: '## Project log (from .forge/project-log.md)\n- did a thing' });
  ok(prefix.includes('## Project log') && prefix.includes('did a thing'), 'projectLogText is spliced into the turn context prefix when provided');
  const withoutLog = buildTurnContextPrefix({});
  ok(withoutLog === '', 'no project-log content appears when none is supplied — a workspace with no history yet gets an empty prefix');
  const systemPrompt = buildSystemPrompt('demo', 'agent', {});
  ok(!systemPrompt.includes('## Project log'), 'buildSystemPrompt() itself never includes the project log — it belongs in the per-turn prefix now, not the cached system message');
}

function testSystemPromptWarnsAboutReplaceWhitespace() {
  const prompt = buildSystemPrompt('demo', 'agent', {});
  ok(/Whitespace and indentation in "replace"/.test(prompt), 'the action contract now explicitly calls out matching indentation style in "replace" text');
}

// ---------- chat/chatSession.ts: mode-changed notification (item 3) ----------

function makeChatSessionServices(root: vscode.Uri): any {
  return {
    ollama: { health: async () => ({ ok: true }) },
    pendingEdits: new PendingEditManager(root),
    backgroundProcesses: new BackgroundProcessManager(),
    workspaceIndex: { search: async () => [] },
    chatMemoryIndex: { indexSession: async () => {}, search: async () => [] },
    rules: { renderForPrompt: async () => '' },
    skills: { expand: async () => undefined },
    hooks: { run: async () => ({ blocked: false }) },
    memory: new MemoryStore(root),
    chatStore: new ChatStore(root),
    webSearchService: {},
    webFetchService: {},
    workspaceRoot: root,
    workspaceName: 'test-workspace',
  };
}

async function testSetModePostsModeChanged() {
  const root = freshWorkspace();
  const services = makeChatSessionServices(root);
  const notifications: any[] = [];
  const session = new ChatSession(services, (_id, msg) => notifications.push(msg));
  session.setMode('auto');
  ok(
    notifications.some((m) => m.type === 'modeChanged' && m.mode === 'auto'),
    'setMode() posts a dedicated modeChanged event, not just relying on a full session sync'
  );
}

async function testExecutePlanPostsModeChanged() {
  // This is the actual regression this round fixes: before it, switching
  // from Plan mode to Agent mode via "Execute plan" changed this.mode
  // internally but never told the webview, which is exactly the
  // "keeps saying I'm in ask/plan mode when it's actually in agent mode" bug.
  const root = freshWorkspace();
  const services = makeChatSessionServices(root);
  const notifications: any[] = [];
  const session = new ChatSession(services, (_id, msg) => notifications.push(msg));
  session.setMode('plan');
  notifications.length = 0;
  (session as any).lastPlan = { entryId: 'plan1', text: 'Do the thing, step by step.' };
  await session.executePlan('plan1');
  ok(
    notifications.some((m) => m.type === 'modeChanged' && m.mode === 'agent'),
    'executePlan() now posts modeChanged when it hands off from Plan mode to Agent mode'
  );
  ok(session.mode === 'agent', 'the session\'s actual mode is agent after executePlan(), matching what was just posted');
}

// ---------- chat/chatSession.ts: per-chat model override (item 12/13) ----------

function testSetModelOverride() {
  const root = freshWorkspace();
  const services = makeChatSessionServices(root);
  const session = new ChatSession(services, () => {});
  ok(session.model === '', 'a fresh session has no model override by default');
  session.setModelOverride('qwen2.5-coder:14b');
  ok(session.model === 'qwen2.5-coder:14b', 'setModelOverride() sets this chat\'s own model override');
  ok(session.toSummaryState().model === 'qwen2.5-coder:14b', 'the override is reflected in toSummaryState(), which is what the webview reads to render the model button');
  session.setModelOverride('');
  ok(session.model === '', 'setModelOverride(\'\') clears the override back to "use the global default"');
}

async function main() {
  await testCancellationKillsWellBehavedCommandQuickly();
  await testSigtermIgnoredEscalatesToSigkill();
  await testTimeoutAlsoEscalatesThroughSameMechanism();
  await testOrdinaryCommandStillWorksNormally();

  await testRaceToolCallRealResultWinsWhenNotCancelled();
  await testRaceToolCallAbortsAfterGracePeriod();
  await testRaceToolCallAlreadyCancelledStillWaitsGracePeriod();

  testCheckLoopExemptsBackgroundCommandUnconditionally();
  testCheckLoopOnByDefaultAndCatchesRepetition();
  testCheckLoopCanBeDisabledViaSetting();
  testConfigExposesLoopDetectionEnabled();
  await testSettingsPanelCanWriteLoopDetection();

  await testMemoryRenderForPromptFallsBackToRecencyWithNoQuery();
  await testMemoryRenderForPromptUsesRelevanceWhenQueryGiven();
  testOverlapScore();
  await testMemoryCompactArchivesUncheckedFacts();
  await testMemoryCompactNoOpWhenNothingUnchecked();

  await testProjectLogAppendAndRead();
  await testProjectLogEmptyWhenNeverWritten();
  await testProjectLogCapsToMostRecentEntries();

  testDominantIndentChar();
  testDetectIndentMismatch();
  await testWriteFileToolAutoFixesIndentMismatch();
  await testWriteFileToolNoAdvisoryWhenIndentMatches();

  testSystemPromptIncludesProjectLogWhenProvided();
  testSystemPromptWarnsAboutReplaceWhitespace();

  await testSetModePostsModeChanged();
  await testExecutePlanPostsModeChanged();
  testSetModelOverride();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.10.0 runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
