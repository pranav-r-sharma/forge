// File mailbox: Cursor drops a task in .agent-bridge/inbox/forge, Forge runs it and writes a reply.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../../src/util/config';
import {
  AgentBridge,
  BridgeResult,
  BridgeTask,
  buildReply,
  parseBridgeFile,
  sanitizeMailboxName,
} from '../../src/bridge/agentBridge';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(15);
  }
  return pred();
}

function mail(opts: { from?: string; to?: string; subject: string; body?: string }): string {
  return `---\nfrom: ${opts.from ?? 'cursor'}\nto: ${opts.to ?? 'forge'}\nsubject: ${opts.subject}\nsent: 2026-01-01T00:00:00-04:00\n---\n\n${opts.body ?? 'please do this'}\n`;
}

function writeMail(root: string, name: string, subject: string, body?: string, from = 'cursor', to = 'forge') {
  const dir = path.join(root, 'inbox', 'forge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), mail({ from, to, subject, body }));
}

function mdNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
}

function replyText(root: string, box: string): string {
  const dir = path.join(root, 'inbox', box);
  const names = mdNames(dir);
  if (!names.length) return '';
  return names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n----\n');
}

function freshRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bridge-'));
}

function testParseAndBuild() {
  const parsed = parseBridgeFile(mail({ subject: 'Fix the parser', body: '@session sess_a_1\n@mode ask\n\nChange the comma.\n' }));
  ok(!!parsed && parsed.from === 'cursor' && parsed.to === 'forge' && parsed.subject === 'Fix the parser', 'frontmatter from/to/subject');
  ok(parsed?.sessionId === 'sess_a_1' && parsed?.mode === 'ask', '@session and @mode on leading lines');
  ok(parsed?.text.trim() === 'Change the comma.', 'directive lines are not part of the task text');

  const later = parseBridgeFile(mail({ subject: 'x', body: 'Do the work.\n@mode plan\n' }));
  ok(later?.mode === undefined && later?.text.includes('@mode plan'), '@mode after real text stays in the body');

  const bad = parseBridgeFile(mail({ subject: 'x', body: '@mode banana\nStill a task.\n' }));
  ok(bad?.mode === undefined && bad?.text.startsWith('@mode banana'), 'unknown @mode is left in the text');

  const reply = buildReply({ to: 'cursor', subject: 'Fix the parser', status: 'done', session: 'sess_a_1', body: 'Done.\n', sent: '2026-01-02T03:04:05-04:00' });
  ok(reply.startsWith('---\nfrom: forge\nto: cursor\nsubject: Re: Fix the parser\n'), 'reply frontmatter routes back to the sender');
  ok(reply.includes('status: done\n') && reply.includes('session: sess_a_1\n') && reply.endsWith('Done.\n'), 'reply carries status, session, and body');

  ok(sanitizeMailboxName('../../x') === 'unknown', 'path-like from name sanitises to unknown');
  ok(sanitizeMailboxName('cursor') === 'cursor', 'a normal mailbox name is kept');
  ok(sanitizeMailboxName('..') === 'unknown' && sanitizeMailboxName('') === 'unknown', 'dot and empty names are refused');
}

async function testSerialOrder() {
  const root = freshRoot();
  const subjects: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    defaultMode: 'plan',
    runner: async (task) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      if (first) {
        first = false;
        await gate;
      } else {
        await sleep(30);
      }
      subjects.push(task.subject);
      inflight--;
      return { ok: true, sessionId: 'sess_a_1', finalText: `answer ${task.subject}` };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-a.md', 'alpha');
    bridge.start();
    ok(await waitUntil(() => inflight === 1), 'first task is in flight');
    writeMail(root, '20260101T000003-cursor-c.md', 'charlie');
    writeMail(root, '20260101T000002-cursor-b.md', 'bravo');
    await sleep(80);
    ok(maxInflight === 1 && subjects.length === 0, 'later files wait; nothing runs beside the claimed task');
    release();
    ok(await waitUntil(() => subjects.length === 3), `all three ran (got ${subjects.join(',')})`);
    ok(subjects.join(',') === 'alpha,bravo,charlie', `oldest filename first (got ${subjects.join(',')})`);
    ok(maxInflight === 1, 'still one at a time after the rest arrived');
    ok(mdNames(path.join(root, 'inbox', 'forge')).length === 0, 'inbox/forge is empty after the run');
    ok(mdNames(path.join(root, 'processing')).length === 0, 'processing/ is empty after the run');
    ok(mdNames(path.join(root, 'archive')).length === 3, 'each claimed file landed in archive/');
    const replies = replyText(root, 'cursor');
    ok(replies.includes('subject: Re: alpha') && replies.includes('subject: Re: bravo') && replies.includes('subject: Re: charlie'), 'replies are named Re: <subject>');
    ok(replies.includes('from: forge') && replies.includes('to: cursor') && replies.includes('status: done') && replies.includes('session: sess_a_1'), 'reply frontmatter routes to the sender');
    ok(replies.includes('answer alpha'), 'reply body is the runner result');
    const replyDir = path.join(root, 'inbox', 'cursor');
    ok(mdNames(replyDir).every((n) => /^\d{8}T\d{6}-forge-/.test(n)), `reply filenames match the bridge stamp (got ${mdNames(replyDir).join(',')})`);
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testCrashRecovery() {
  const root = freshRoot();
  const seen: string[] = [];
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async (task) => {
      seen.push(task.subject);
      return { ok: true, sessionId: 'sess_r_1', finalText: 'reran' };
    },
  });
  try {
    const processing = path.join(root, 'processing');
    fs.mkdirSync(processing, { recursive: true });
    fs.writeFileSync(path.join(processing, '20260101T000001-cursor-left.md'), mail({ subject: 'left behind' }));
    bridge.start();
    ok(await waitUntil(() => seen.length === 1), 'a file left in processing/ runs on start');
    ok(seen[0] === 'left behind', 'the recovered file is the one that was in processing/');
    ok(mdNames(processing).length === 0, 'processing/ is cleared');
    ok(mdNames(path.join(root, 'archive')).length === 1, 'recovered file is archived after the rerun');
    ok(replyText(root, 'cursor').includes('status: done') && replyText(root, 'cursor').includes('reran'), 'recovery still writes a reply');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testIgnored() {
  const root = freshRoot();
  let calls = 0;
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async () => {
      calls++;
      return { ok: true, sessionId: 's', finalText: 'ran' };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-nope.md', 'not mine', 'no', 'cursor', 'cursor');
    fs.writeFileSync(path.join(root, 'inbox', 'forge', 'notes.txt'), 'ignore me');
    writeMail(root, '20260101T000002-cursor-yes.md', 'mine');
    bridge.start();
    ok(await waitUntil(() => calls === 1), 'the forge-addressed file still runs');
    await sleep(80);
    ok(calls === 1, 'mail to someone else is not run');
    ok(fs.existsSync(path.join(root, 'inbox', 'forge', '20260101T000001-cursor-nope.md')), 'to != forge stays in the inbox');
    ok(fs.existsSync(path.join(root, 'inbox', 'forge', 'notes.txt')), 'non-md files are ignored');
    ok(!replyText(root, 'cursor').includes('Re: not mine'), 'ignored mail gets no reply');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRejects() {
  const root = freshRoot();
  const outside = path.join(os.tmpdir(), `forge-bridge-outside-${Date.now()}.txt`);
  let calls = 0;
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async () => {
      calls++;
      return { ok: true, sessionId: 's', finalText: 'should not' };
    },
  });
  try {
    const inbox = path.join(root, 'inbox', 'forge');
    fs.mkdirSync(inbox, { recursive: true });
    const target = path.join(root, 'real-target.md');
    fs.writeFileSync(target, mail({ subject: 'via link', body: 'secret task' }));
    fs.symlinkSync(target, path.join(inbox, '20260101T000001-cursor-link.md'));
    fs.writeFileSync(outside, 'leave me alone');
    fs.symlinkSync(outside, path.join(root, 'inbox', 'forge', '20260101T000002-cursor-out.md'));
    const header = mail({ subject: 'too big', body: '' });
    fs.writeFileSync(path.join(root, 'inbox', 'forge', '20260101T000003-cursor-big.md'), header + 'x'.repeat(200 * 1024));
    bridge.start();
    ok(await waitUntil(() => replyText(root, 'cursor').includes('symlink') && replyText(root, 'cursor').includes('200KB')), 'symlink and oversize get error replies');
    ok(await waitUntil(() => replyText(root, 'unknown').includes('symlink')), 'a symlink that points outside still gets an error reply inside the mailbox');
    await sleep(50);
    ok(calls === 0, 'rejected files never reach the runner');
    ok(fs.readFileSync(outside, 'utf8') === 'leave me alone', 'the outside symlink target was not read or written');
    ok(fs.readFileSync(target, 'utf8').includes('secret task'), 'the inside symlink target was not rewritten');
    ok(!fs.existsSync(path.join(root, 'inbox', 'forge', '20260101T000001-cursor-link.md')), 'rejected symlink left the inbox');
    ok(mdNames(path.join(root, 'archive')).length === 3, 'rejected files were archived');
    const outsideReply = path.join(root, 'inbox', 'unknown');
    ok(path.resolve(outsideReply).startsWith(path.resolve(root) + path.sep), 'the outside-symlink reply stays under the mailbox');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
}

async function testRunnerFailures() {
  const root = freshRoot();
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async (task: BridgeTask): Promise<BridgeResult> => {
      if (task.subject === 'boom') throw new Error('runner blew up');
      if (task.subject === 'soft') return { ok: false, sessionId: 'sess_e_1', finalText: 'partial', error: 'nope' };
      return { ok: true, sessionId: 'sess_ok_1', finalText: 'all good' };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-boom.md', 'boom');
    writeMail(root, '20260101T000002-cursor-soft.md', 'soft');
    writeMail(root, '20260101T000003-cursor-ok.md', 'ok');
    bridge.start();
    ok(await waitUntil(() => replyText(root, 'cursor').includes('all good')), 'a throw does not stop the watcher from running the next files');
    const replies = replyText(root, 'cursor');
    ok(/status: error[\s\S]*runner blew up/.test(replies), 'a thrown runner becomes status: error with the message');
    ok(replies.includes('status: error') && replies.includes('partial') && replies.includes('nope'), 'ok:false reply includes the final text and the error');
    ok(replies.includes('session: sess_e_1') && replies.includes('status: done') && replies.includes('session: sess_ok_1'), 'soft-fail keeps its session id and the next task still completes');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testStop() {
  const root = freshRoot();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async () => {
      calls++;
      if (calls === 1) await gate;
      return { ok: true, sessionId: 's', finalText: 'done' };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-one.md', 'one');
    writeMail(root, '20260101T000002-cursor-two.md', 'two');
    bridge.start();
    ok(await waitUntil(() => calls === 1), 'stop test: first task started');
    bridge.stop();
    release();
    await sleep(200);
    ok(calls === 1, 'stop() does not start another task');
    ok(fs.existsSync(path.join(root, 'inbox', 'forge', '20260101T000002-cursor-two.md')), 'the unclaimed file stays in the inbox');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPathTraversal() {
  const root = freshRoot();
  const parent = path.dirname(root);
  const before = new Set(fs.readdirSync(parent));
  const seen: BridgeTask[] = [];
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    runner: async (task) => {
      seen.push(task);
      return { ok: true, sessionId: 'sess_t_1', finalText: 'kept inside' };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-escape.md', 'escape', 'do it safely\n', '../../x');
    writeMail(root, '20260101T000002-cursor-badsess.md', 'badsess', '@session ../../etc\nnope\n');
    bridge.start();
    ok(await waitUntil(() => replyText(root, 'unknown').includes('kept inside') && replyText(root, 'cursor').includes('Invalid @session')), 'traversal from gets a reply, bad @session gets an error');
    await sleep(40);
    ok(seen.length === 1 && seen[0].from === '../../x', 'a path-like from: still runs, but the raw name is not used as a folder');
    const reply = replyText(root, 'unknown');
    ok(reply.includes('to: unknown') && !reply.includes('../../x'), 'from: ../../x is sanitised in the reply');
    const after = fs.readdirSync(parent).filter((n) => !before.has(n));
    ok(after.length === 0, `no files appeared beside the mailbox (got ${after.join(',')})`);
    const inbox = path.join(root, 'inbox');
    for (const name of fs.readdirSync(inbox)) {
      const resolved = path.resolve(inbox, name);
      ok(resolved.startsWith(path.resolve(root) + path.sep), `inbox/${name} stays inside the mailbox`);
    }
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testModes() {
  const root = freshRoot();
  const seen: BridgeTask[] = [];
  const bridge = new AgentBridge({
    mailboxRoot: root,
    pollMs: 20,
    defaultMode: 'plan',
    runner: async (task) => {
      seen.push(task);
      return { ok: true, sessionId: 'sess_m_1', finalText: task.mode ?? 'none' };
    },
  });
  try {
    writeMail(root, '20260101T000001-cursor-def.md', 'def', 'just text\n');
    writeMail(root, '20260101T000002-cursor-ask.md', 'ask', '@mode ask\nask this\n');
    writeMail(root, '20260101T000003-cursor-cont.md', 'cont', '@session sess_m_1\ncontinue\n');
    bridge.start();
    ok(await waitUntil(() => seen.length === 3), 'mode cases all ran');
    ok(seen[0].mode === 'plan' && seen[0].text.startsWith('just text'), 'new chat with no @mode uses defaultMode');
    ok(seen[1].mode === 'ask', '@mode overrides the default');
    ok(seen[2].sessionId === 'sess_m_1' && seen[2].mode === undefined, '@session without @mode does not force the default mode');
  } finally {
    bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testSettings() {
  const vs = vscode as any;
  vs.__resetConfig();
  ok(getConfig().bridgeEnabled === false, 'forge.bridge.enabled defaults to false');
  ok(getConfig().bridgeDefaultMode === 'agent', 'forge.bridge.defaultMode defaults to agent');
  vs.__setConfig({ 'forge.bridge.enabled': true, 'forge.bridge.defaultMode': 'outcome' });
  ok(getConfig().bridgeEnabled === true, 'forge.bridge.enabled reads true');
  ok(getConfig().bridgeDefaultMode === 'outcome', 'forge.bridge.defaultMode reads outcome');
  vs.__setConfig({ 'forge.bridge.defaultMode': 'nope' });
  ok(getConfig().bridgeDefaultMode === 'agent', 'a bad defaultMode falls back to agent');
  vs.__resetConfig();
}

(async () => {
  testParseAndBuild();
  await testSerialOrder();
  await testCrashRecovery();
  await testIgnored();
  await testRejects();
  await testRunnerFailures();
  await testStop();
  await testPathTraversal();
  await testModes();
  testSettings();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
