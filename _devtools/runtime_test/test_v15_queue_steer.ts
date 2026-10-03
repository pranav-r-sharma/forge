// ============================================================================
// Queue + steer: messages sent while a turn is running are injected at the
// next step boundary in Agent/Auto/Outcome, stay queued in Ask/Plan and for
// sub-agents, and drain as a new turn after the current one ends — unless
// the user pressed Stop.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn, STEERING_USER_PREFIX, modeAcceptsSteering } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { ChatStore } from '../../src/forge/chatStore';
import { ChatSession } from '../../src/chat/chatSession';
import { pinUserMessagesForCompaction } from '../../src/agent/pinnedUserCompaction';
import { AgentEvent } from '../../src/agent/types';

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

const TOOL_STEP = '```forge_action\n{"tool": "list_files", "args": {"path": "."}}\n```';
const FINAL = 'All done, the command is added.';

function loopDeps(fakeOllama: any, events: AgentEvent[]) {
  const workspaceRoot = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-steer-')));
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
    workspaceRoot,
    workspaceName: 'test',
  } as any;
}

function testModeGate() {
  ok(modeAcceptsSteering('agent') && modeAcceptsSteering('auto') && modeAcceptsSteering('outcome'), 'agent, auto, and outcome accept steering');
  ok(!modeAcceptsSteering('ask') && !modeAcceptsSteering('plan'), 'ask and plan do not accept steering');
}

function testSteeringMessagesArePinned() {
  const archival = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'original ask' },
    { role: 'assistant' as const, content: 'did a tool call' },
    { role: 'user' as const, content: `${STEERING_USER_PREFIX}please also rename the helper` },
  ];
  const pinned = pinUserMessagesForCompaction(archival, 1, archival.length, 40_000);
  ok(
    pinned.some((m) => m.content.startsWith(STEERING_USER_PREFIX) && m.content.includes('rename the helper')),
    'a steered user message is pinned for compaction like any other real user message'
  );
}

async function testSteeringInjectedAtNextStep() {
  const queued: string[] = [];
  const seen: { role: string; content: string }[][] = [];
  let step = 0;
  const events: AgentEvent[] = [];
  const fake = {
    chat: async (req: any) => {
      seen.push(req.messages.map((m: any) => ({ role: m.role, content: m.content })));
      if (step++ === 0) {
        queued.push('first follow-up');
        queued.push('second follow-up');
        return TOOL_STEP;
      }
      return FINAL;
    },
  };
  await runAgentTurn(
    [],
    'add a delete command',
    loopDeps(fake, events),
    (e) => events.push(e),
    new vscode.CancellationTokenSource().token,
    'fake-model',
    {
      mode: 'agent',
      takeSteeringMessages: () => {
        const batch = queued.splice(0, queued.length);
        return batch.map((text) => ({ text }));
      },
    } as any
  );
  ok(seen.length === 2, `steering waits for the next step (model calls=${seen.length}, want 2)`);
  ok(!seen[0].some((m) => m.content.includes(STEERING_USER_PREFIX)), 'the first model call does not see messages that arrive during it');
  const second = seen[1];
  const firstIdx = second.findIndex((m) => m.role === 'user' && m.content === `${STEERING_USER_PREFIX}first follow-up`);
  const secondIdx = second.findIndex((m) => m.role === 'user' && m.content === `${STEERING_USER_PREFIX}second follow-up`);
  ok(firstIdx > 0 && secondIdx === firstIdx + 1, `steered messages keep queue order and sit after earlier messages (idx ${firstIdx}, ${secondIdx})`);
  const toolIdx = second.findIndex((m) => m.role === 'user' && m.content.startsWith('[Tool '));
  ok(toolIdx >= 0 && firstIdx > toolIdx, 'steering is appended after the previous step tool result, not before it');
  const original0 = seen[0].find((m) => m.role === 'user');
  const original1 = seen[1].find((m) => m.role === 'user');
  ok(!!original0 && original0.content === original1?.content, 'the original user message is unchanged when steering is appended');
  ok(queued.length === 0, 'taken messages leave the queue');
}

async function testNotInjectedInAskPlanOrSubagent() {
  for (const mode of ['ask', 'plan'] as const) {
    const queued = ['do not inject'];
    let calls = 0;
    const events: AgentEvent[] = [];
    let step = 0;
    const fake = {
      chat: async () => {
        if (step++ === 0 && mode === 'ask') return TOOL_STEP;
        return FINAL;
      },
    };
    await runAgentTurn([], 'question', loopDeps(fake, events), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', {
      mode,
      takeSteeringMessages: () => {
        calls++;
        return queued.splice(0).map((text) => ({ text }));
      },
    } as any);
    ok(calls === 0, `${mode} mode never calls takeSteeringMessages (calls=${calls})`);
    ok(queued[0] === 'do not inject', `${mode} mode leaves the queued message in place`);
  }

  const queued = ['no subagent steer'];
  let calls = 0;
  const events: AgentEvent[] = [];
  let step = 0;
  const fake = {
    chat: async () => (step++ === 0 ? TOOL_STEP : FINAL),
  };
  await runAgentTurn([], 'delegated', loopDeps(fake, events), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', {
    mode: 'auto',
    subAgentDepth: 1,
    takeSteeringMessages: () => {
      calls++;
      return queued.splice(0).map((text) => ({ text }));
    },
  } as any);
  ok(calls === 0, `sub-agents (depth>0) never take steering messages (calls=${calls})`);
  ok(queued[0] === 'no subagent steer', 'a sub-agent leaves the queue untouched');
}

async function testMessageAfterFinalStaysQueued() {
  const queued: string[] = [];
  let takes = 0;
  const events: AgentEvent[] = [];
  const fake = {
    chat: async () => {
      queued.push('arrived during the final answer');
      return FINAL;
    },
  };
  const result = await runAgentTurn([], 'start', loopDeps(fake, events), (e) => events.push(e), new vscode.CancellationTokenSource().token, 'fake-model', {
    mode: 'agent',
    takeSteeringMessages: () => {
      takes++;
      const batch = queued.splice(0, queued.length);
      return batch.map((text) => ({ text }));
    },
  } as any);
  ok(takes === 1, `the callback runs at the step boundary and not again after final (takes=${takes})`);
  ok(queued.length === 1 && queued[0] === 'arrived during the final answer', 'a message that arrives after the last step boundary stays queued');
  ok(
    !result.messages.some((m) => m.content.includes('arrived during the final answer')),
    'that late message is not injected into the turn that already finished'
  );
}

function freshRoot(): vscode.Uri {
  return vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-queue-')));
}

function sessionServices(root: vscode.Uri, ollama: any, skills: any) {
  return {
    ollama,
    pendingEdits: new PendingEditManager(root),
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    workspaceIndex: { search: async () => [] },
    chatMemoryIndex: { indexSession: async () => {}, search: async () => [] },
    rules: { renderForPrompt: async () => '' },
    skills,
    hooks: { run: async () => ({ blocked: false }) },
    memory: { renderForPrompt: async () => '', addFact: async () => ({ added: false }), listFacts: async () => [] },
    chatStore: new ChatStore(root),
    webSearchService: {},
    webFetchService: {},
    mcpManager: { listToolSpecs: () => [] },
    workspaceRoot: root,
    workspaceName: 'queue-test',
  } as any;
}

function makeSession(ollama: any, skills?: any, notes?: any[]) {
  const root = freshRoot();
  const services = sessionServices(root, ollama, skills || { expand: async () => undefined });
  const session = new ChatSession(services, (_id, msg) => notes?.push(msg));
  session.setModelOverride('fake-model');
  return { session, root, services };
}

async function testQueuePersistEditRemoveSendNow() {
  const notes: any[] = [];
  const { session } = makeSession({ health: async () => ({ ok: true }), chat: async () => FINAL }, undefined, notes);
  session.busy = true;
  await session.send('   ', []);
  ok(!session.toStored().queuedMessages, 'a blank message is not queued');
  await session.send('alpha', ['a.ts']);
  await session.send('beta', []);
  await session.send('gamma', ['c.ts']);
  const queued = session.toStored().queuedMessages || [];
  ok(queued.map((q) => q.text).join(',') === 'alpha,beta,gamma', `queue is FIFO (${queued.map((q) => q.text).join(',')})`);
  ok(queued[0].files?.[0] === 'a.ts' && typeof queued[0].queuedAt === 'string', 'queued items keep files and a timestamp');
  ok(notes.some((m) => m.type === 'queueUpdate' && m.queue.length === 3), 'the webview gets a queueUpdate snapshot');

  session.editQueuedMessage(queued[0].id, 'alpha-edited');
  session.removeQueuedMessage(queued[1].id);
  await session.sendQueuedNow(queued[2].id);
  const after = session.toStored().queuedMessages || [];
  ok(after.map((q) => q.text).join(',') === 'gamma,alpha-edited', `send-now while busy moves that item to the front; edit and remove stick (${after.map((q) => q.text).join(',')})`);
  ok(session.busy === true, 'send-now while busy does not start a second turn');
}

async function testQueueRoundTrip(services: any, stored: any) {
  const reloaded = ChatSession.fromStored(stored, services, () => {});
  const again = reloaded.toStored().queuedMessages || [];
  ok(again.map((q) => q.text).join(',') === 'gamma,alpha-edited', 'fromStored restores the queue');
  ok(again[1].files?.[0] === 'a.ts', 'restored items keep their files');
  ok(reloaded.toSummaryState().queue.length === 2, 'toSummaryState exposes the queue to the webview');
  reloaded.busy = false;
}

async function testPersistUsesServices() {
  const { session, services } = makeSession({ health: async () => ({ ok: true }), chat: async () => FINAL });
  session.busy = true;
  await session.send('alpha', ['a.ts']);
  await session.send('beta', []);
  await session.send('gamma', ['c.ts']);
  const queued = session.toStored().queuedMessages || [];
  session.editQueuedMessage(queued[0].id, 'alpha-edited');
  session.removeQueuedMessage(queued[1].id);
  await session.sendQueuedNow(queued[2].id);
  const stored = session.toStored();
  await testQueueRoundTrip(services, stored);
  session.busy = false;
}

async function testSendNowWhenIdle() {
  let calls = 0;
  const { session } = makeSession({
    health: async () => ({ ok: true }),
    chat: async () => {
      calls++;
      return FINAL;
    },
  });
  session.busy = true;
  await session.send('later please', ['note.ts']);
  const id = session.toStored().queuedMessages![0].id;
  session.busy = false;
  await session.sendQueuedNow(id);
  ok(calls === 1, `send-now while idle starts a turn (calls=${calls})`);
  ok(!session.toStored().queuedMessages, 'the sent message leaves the queue');
  const user = session.uiHistory.find((e) => e.kind === 'user' && e.text === 'later please');
  ok(!!user && !(user as any).midTurn && (user as any).files?.[0] === 'note.ts', 'an idle send-now is a normal user turn carrying its files');
  ok(session.busy === false, 'the chat is idle after send-now finishes');
}

async function testDrainAfterDoneAndNotAfterStop() {
  const root = freshRoot();
  fs.writeFileSync(path.join(root.fsPath, 'note.txt'), 'file-body');
  let live: ChatSession | undefined;
  const seen: string[][] = [];
  let stopRun = false;
  const ollama = {
    health: async () => ({ ok: true }),
    chat: async (req: any) => {
      seen.push(req.messages.map((m: any) => m.content));
      if (!stopRun && seen.length === 1) {
        await live!.send('/demo please', ['note.txt']);
      }
      if (stopRun && seen.length === 1) {
        await live!.send('keep me', []);
        live!.stop();
      }
      return FINAL;
    },
  };
  const skills = {
    expand: async (text: string) =>
      text.trim().startsWith('/demo') ? { expanded: 'EXPANDED please', skillUsed: 'demo' } : undefined,
  };
  const services = sessionServices(root, ollama, skills);
  live = new ChatSession(services, () => {});
  live.setModelOverride('fake-model');
  await live.send('start', []);
  ok(seen.length === 2, `a message that arrives during the final answer drains as the next turn (calls=${seen.length})`);
  ok(!seen[0].some((c) => c.includes('EXPANDED') || c.includes('/demo')), 'it is not injected into the turn that already answered');
  const drained = seen[1].join('\n');
  ok(drained.includes('EXPANDED please'), 'slash commands expand when the queued message is sent');
  ok(drained.includes('[Attached file: note.txt]') && drained.includes('file-body'), 'attachments are carried into the drained turn');
  ok(!drained.includes(STEERING_USER_PREFIX), 'a drained message is a new turn, not a mid-turn steer');
  ok(live.uiHistory.some((e) => e.kind === 'system' && e.text === 'Expanded /demo'), 'skill expansion is noted in the transcript');
  ok(!live.toStored().queuedMessages, 'the queue is empty after the drain');

  seen.length = 0;
  stopRun = true;
  const root2 = freshRoot();
  const services2 = sessionServices(root2, ollama, skills);
  live = new ChatSession(services2, () => {});
  live.setModelOverride('fake-model');
  await live.send('start', []);
  ok(seen.length === 1, `Stop does not auto-drain (calls=${seen.length})`);
  ok(live.toStored().queuedMessages?.[0]?.text === 'keep me', 'Stop keeps the queue');
  ok(live.busy === false, 'the chat is idle after Stop, with the queue still visible');
}

async function testSessionSteersAtNextStep() {
  const root = freshRoot();
  fs.writeFileSync(path.join(root.fsPath, 'note.txt'), 'file-body');
  let live: ChatSession | undefined;
  const seen: string[][] = [];
  let step = 0;
  const ollama = {
    health: async () => ({ ok: true }),
    chat: async (req: any) => {
      seen.push(req.messages.map((m: any) => m.content));
      if (step++ === 0) {
        await live!.send('/demo please', ['note.txt']);
        await live!.send('second', []);
        return TOOL_STEP;
      }
      return FINAL;
    },
  };
  const skills = {
    expand: async (text: string) =>
      text.trim().startsWith('/demo') ? { expanded: 'EXPANDED please', skillUsed: 'demo' } : undefined,
  };
  live = new ChatSession(sessionServices(root, ollama, skills), () => {});
  live.setModelOverride('fake-model');
  await live.send('start work', []);
  ok(seen.length === 2, `session steering reaches the next model call (calls=${seen.length})`);
  const second = seen[1].join('\n---\n');
  const a = second.indexOf(`${STEERING_USER_PREFIX}EXPANDED please`);
  const b = second.indexOf(`${STEERING_USER_PREFIX}second`);
  ok(a >= 0 && b > a, 'both queued messages are steered, in order, with the skill expanded');
  ok(second.includes('file-body'), 'the steered message includes its attachment');
  const mid = live.uiHistory.filter((e) => e.kind === 'user' && (e as any).midTurn);
  ok(mid.length === 2 && mid[0].text === '/demo please' && (mid[0] as any).files?.[0] === 'note.txt', 'steered messages show in the transcript with a mid-turn marker and the original text');
  ok(live.uiHistory.some((e) => e.kind === 'system' && e.text === 'Expanded /demo'), 'steering a /skill notes the expansion');
  ok(!live.toStored().queuedMessages, 'steered messages leave the queue');
  ok(!seen[0].some((c) => c.includes(STEERING_USER_PREFIX)), 'they are not visible to the model call that was already running');
}

(async () => {
  (vscode as any).__setConfig?.({ 'forge.trace.enabled': false, 'forge.planFirst.enabled': false, 'forge.requirements.enabled': false, 'forge.webSearch.enabled': false });
  testModeGate();
  testSteeringMessagesArePinned();
  await testSteeringInjectedAtNextStep();
  await testNotInjectedInAskPlanOrSubagent();
  await testMessageAfterFinalStaysQueued();
  await testQueuePersistEditRemoveSendNow();
  await testPersistUsesServices();
  await testSendNowWhenIdle();
  await testDrainAfterDoneAndNotAfterStop();
  await testSessionSteersAtNextStep();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
