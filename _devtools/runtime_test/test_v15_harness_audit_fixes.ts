// Harness audit fixes 1–5 (2026-09-30) — unit tests only, no live model.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn, checkLoop } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { AgentEvent } from '../../src/agent/types';
import {
  LoopDetector,
  isProgressiveReadFileCycle,
  parseReadFileSignature,
  signatureForStep,
} from '../../src/agent/loopDetector';
import {
  getConfig,
  setForgeSetting,
  SETTINGS_PANEL_KEYS,
  isUserConfiguredPanelSetting,
  storageKeyForPanelSetting,
} from '../../src/util/config';
import { shouldSkipApplyAllRecommendation } from '../../src/util/recommendations';

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
const vs: any = vscode;
const act = (tool: string, args: any) => '```forge_action\n' + JSON.stringify({ tool, args }) + '\n```';
const CYCLE_HISTORY_SIZE = 16;

function deps(root: vscode.Uri, ollama: any) {
  return {
    ollama,
    pendingEdits: new PendingEditManager(root),
    approvalBroker: new ApprovalBroker(() => {}, () => [], () => false),
    hooks: new HookRunner(root),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    taskLedger: { addTasks: () => [], updateTask: () => true, list: () => [] },
    workspaceRoot: root,
    workspaceName: 't',
  } as any;
}

function scripted(replies: [string, string][]) {
  let i = 0;
  return {
    chat: async (o: any) => {
      const [text, reason] = replies[Math.min(i++, replies.length - 1)];
      o.onMetrics?.({ model: 'f', promptTokens: 10, evalTokens: 5, finishReason: reason });
      return text;
    },
  };
}

function testSplitTruncationCounters() {
  // covered by testSplitTruncationCountersAsync
}

async function testSplitTruncationCountersAsync() {
  const unknown = '<tool_call>{"name":"bash","arguments":{"cmd":"x"}}</tool_call>';
  const partial = '```forge_action\n{"tool":"write_file","args":{"path":"x.py","content":"def a(';
  const m = scripted([
    [unknown, 'stop'],
    [unknown, 'stop'],
    [unknown, 'stop'],
    [partial, 'length'],
    [act('read_file', { path: 'a.txt' }), 'stop'],
    ['done', 'stop'],
  ]);
  const ws = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-audit-')));
  fs.writeFileSync(path.join(ws.fsPath, 'a.txt'), 'hi\n');
  let calls = 0;
  const ollama = {
    chat: async (o: any) => {
      calls++;
      const replies: [string, string][] = [
        [unknown, 'stop'],
        [unknown, 'stop'],
        [unknown, 'stop'],
        [partial, 'length'],
        [act('read_file', { path: 'a.txt' }), 'stop'],
        ['done', 'stop'],
      ];
      const [text, reason] = replies[Math.min(calls - 1, replies.length - 1)];
      o.onMetrics?.({ model: 'f', promptTokens: 10, evalTokens: 5, finishReason: reason });
      return text;
    },
  };
  const ev: AgentEvent[] = [];
  await runAgentTurn([], 'go', deps(ws, ollama), (e) => ev.push(e), new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto' });
  ok(calls === 6, `split counters: 3 foreign + 1 incomplete nudge + read + final (${calls} model calls)`);
  ok(ev.some((e) => e.type === 'final'), 'run completes after incomplete recovery');
}

async function testVerifyFailTranscriptNote() {
  vs.__resetConfig();
  vs.__setConfig({ 'forge.verifyBeforeDone': 'custom', 'forge.verifyCommand': 'false', 'forge.requireApprovalForWrites': false });
  const ws = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vbd-')));
  fs.writeFileSync(path.join(ws.fsPath, 't.txt'), 'x\n');
  let step = 0;
  const ollama = {
    chat: async (o: any) => {
      step++;
      const text = step === 1 ? act('write_file', { path: 't.txt', content: 'y\n' }) : 'All done now.';
      o.onMetrics?.({ model: 'f', promptTokens: 10, evalTokens: 5, finishReason: 'stop' });
      return text;
    },
  };
  const { messages } = await runAgentTurn(
    [],
    'edit t.txt',
    deps(ws, ollama),
    () => {},
    new vscode.CancellationTokenSource().token,
    'fake',
    { mode: 'auto' }
  );
  const assistants = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  ok(
    assistants.some((c) => /not accepted.*definition-of-done check failed/i.test(c)),
    'verify failure appends a corrective note on the assistant message',
  );
  vs.__resetConfig();
}

function testLoopProgressiveReads() {
  const ranges = [
    { start_line: 1, end_line: 272 },
    { start_line: 273, end_line: 560 },
    { start_line: 560, end_line: 808 },
    { start_line: 808, end_line: 952 },
  ];
  const firstPass = ranges.map((r, i) =>
    signatureForStep('read_file', { path: 'big.ts', ...r }, true, `chunk ${i}`),
  );
  while (firstPass.length < CYCLE_HISTORY_SIZE) {
    const r = ranges[firstPass.length % 4];
    firstPass.push(signatureForStep('read_file', { path: 'big.ts', ...r }, true, `more ${firstPass.length}`));
  }
  ok(!isProgressiveReadFileCycle(firstPass), 'repeated chunk rotation is not progressive');

  const onePassOnly = ranges.map((r, i) =>
    signatureForStep('read_file', { path: 'big.ts', ...r }, true, `once ${i}`),
  );
  ok(!isProgressiveReadFileCycle(onePassOnly), 'fewer than 16 steps never counts as a progressive cycle window');

  const same = Array.from({ length: 16 }, () =>
    signatureForStep('read_file', { path: 'a.ts', start_line: 1, end_line: 50 }, true, 'same'),
  );
  ok(!isProgressiveReadFileCycle(same), 'identical read ranges are not progressive');

  const progressive16: string[] = [];
  for (let i = 0; i < 16; i++) {
    const start = i * 80 + 1;
    progressive16.push(
      signatureForStep('read_file', { path: 'big.ts', start_line: start, end_line: start + 79 }, true, `line ${i}`),
    );
  }
  ok(isProgressiveReadFileCycle(progressive16), 'sixteen sequential new chunks are progressive');

  const afterWriteWindow: string[] = [
    signatureForStep('write_file', { path: 'big.ts', content: 'x' }, true, 'Updated big.ts.'),
  ];
  for (let i = 0; i < 15; i++) {
    const start = i * 50 + 1;
    afterWriteWindow.push(
      signatureForStep('read_file', { path: 'big.ts', start_line: start, end_line: start + 49 }, true, `w${i}`),
    );
  }
  ok(isProgressiveReadFileCycle(afterWriteWindow), 'reads after a write in the window are fresh progress');

  ok(parseReadFileSignature(firstPass[0])?.path === 'big.ts', 'parseReadFileSignature reads path');
}

function testVerifyLoopSkipWithProgress() {
  const detector = new LoopDetector({ consecutiveLimit: 3 });
  const cmd = { command: 'false' };
  const out = 'fail output';
  let stopped = false;
  for (let i = 0; i < 5 && !stopped; i++) {
    stopped = checkLoop(detector, '__verify__', cmd, false, out, () => {}, { skipWhenWorkspaceProgress: i > 0 });
  }
  ok(!stopped, 'verify repeats are skipped when workspace progress flag is set');
  const detector2 = new LoopDetector({ consecutiveLimit: 3 });
  stopped = false;
  for (let i = 0; i < 5 && !stopped; i++) {
    stopped = checkLoop(detector2, '__verify__', cmd, false, out, () => {}, {});
  }
  ok(stopped, 'identical verify with no progress still stops after warn+repeat');
}

async function testSettingsPanelKeys() {
  vs.__resetConfig();
  for (const key of ['thinking', 'terseSteps', 'context.appendOnly', 'trace.enabled', 'provider']) {
    ok((SETTINGS_PANEL_KEYS as readonly string[]).includes(key), `${key} is in SETTINGS_PANEL_KEYS`);
  }
  ok(storageKeyForPanelSetting('numCtx', 'mlx') === 'mlx.contextTokens', 'numCtx remaps to mlx.contextTokens on MLX');
  const applied = await setForgeSetting('thinking', 'off');
  ok(applied && getConfig().thinking === 'off', 'thinking can be written via setForgeSetting');
  vs.__resetConfig();
}

function testApplyAllSkipsUserConfigured() {
  ok(
    shouldSkipApplyAllRecommendation({ settingKey: 'numCtx', recommended: 65536, reason: 'x', userConfigured: true, userValue: 131072 }, 131072),
    'Apply all skips user-configured keys',
  );
  ok(
    !shouldSkipApplyAllRecommendation({ settingKey: 'numCtx', recommended: 65536, reason: 'x', userConfigured: false }, 131072),
    'Apply all may change unset keys that differ from recommendation',
  );
  ok(
    shouldSkipApplyAllRecommendation({ settingKey: 'numCtx', recommended: 131072, reason: 'x', userConfigured: false }, 131072),
    'Apply all skips when already at recommended value',
  );
}

async function main() {
  testLoopProgressiveReads();
  testVerifyLoopSkipWithProgress();
  await testSettingsPanelKeys();
  testApplyAllSkipsUserConfigured();
  await testSplitTruncationCountersAsync();
  await testVerifyFailTranscriptNote();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.15.0 harness audit fix tests FAILED.');
    process.exit(1);
  }
  console.log('All v0.15.0 harness audit fix tests passed.');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
