// Regression test for the 0.2.1 "closed chats reappear" bug.
//
// The bug wasn't in ChatStore itself (its delete() was always correct) — it
// was that chatViewProvider.ts's closeSession handler never called it. This
// test locks down the contract closeSession now depends on: after delete(id),
// that session must be gone from both the index (listSessions) and load(id),
// and must never come back on a subsequent list call. It won't catch a
// regression in chatViewProvider.ts wiring itself (that needs the real
// extension host — see README → Testing), but it does pin the exact
// behavior that handler is supposed to rely on.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatStore, StoredSession } from '../../src/forge/chatStore';

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

function makeSession(id: string, title: string): StoredSession {
  const now = new Date().toISOString();
  return { id, title, mode: 'agent', model: 'test-model', createdAt: now, updatedAt: now, uiHistory: [], modelHistory: [] };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chatstore-test-'));
  const root = vscode.Uri.file(tmp);
  const store = new ChatStore(root);

  await store.save(makeSession('a', 'First chat'));
  await store.save(makeSession('b', 'Second chat'));
  await store.save(makeSession('c', 'Third chat'));

  ok((await store.listSessions()).length === 3, 'three sessions listed after saving three');

  await store.delete('b');

  const afterDelete = await store.listSessions();
  ok(afterDelete.length === 2, 'listSessions drops to two after deleting one');
  ok(!afterDelete.some((s) => s.id === 'b'), 'deleted session id is absent from listSessions()');
  ok((await store.load('b')) === undefined, 'load() returns undefined for a deleted session');
  ok(fs.existsSync(path.join(tmp, '.forge', 'chat', 'a.json')), 'other sessions on disk are untouched by delete');
  ok(!fs.existsSync(path.join(tmp, '.forge', 'chat', 'b.json')), "deleted session's JSON file is actually removed from disk");

  // The exact shape of the original bug: re-reading the list repeatedly
  // must never resurrect a deleted id, since chatViewProvider rebuilds its
  // tab strip from listSessions() on every refresh.
  await store.listSessions();
  await store.listSessions();
  const stillGone = await store.listSessions();
  ok(!stillGone.some((s) => s.id === 'b'), 'deleted session does not reappear across repeated listSessions() calls');

  await store.delete('a');
  await store.delete('c');
  ok((await store.listSessions()).length === 0, 'all sessions gone after deleting the rest');

  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------- close (archive) vs. delete — the fix for "chats can't be
  // closed" (closing used to permanently delete with no way back; now it
  // just hides the chat from the open-tabs strip while keeping it on disk) ----------
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-chatstore-close-test-'));
  const root2 = vscode.Uri.file(tmp2);
  const store2 = new ChatStore(root2);

  await store2.save(makeSession('x', 'Chat X'));
  await store2.save(makeSession('y', 'Chat Y'));

  const beforeClose = await store2.listSessions();
  ok(beforeClose.every((s) => !s.closed), 'sessions start out open (closed is falsy) by default');

  await store2.setClosed('x', true);
  const afterClose = await store2.listSessions();
  const closedX = afterClose.find((s) => s.id === 'x');
  ok(!!closedX && closedX.closed === true, 'setClosed(id, true) marks the session closed in the index');
  ok(fs.existsSync(path.join(tmp2, '.forge', 'chat', 'x.json')), 'closing a chat does NOT delete its session file — this is the actual archive, not delete');
  ok((await store2.load('x')) !== undefined, 'a closed chat still loads normally — closing never touches session content, only the index flag');

  // The exact bug this test set exists to pin: persisting a closed chat
  // again (every turn calls save()) must not silently reopen it.
  await store2.save(makeSession('x', 'Chat X — updated'));
  const afterResave = await store2.listSessions();
  const stillClosed = afterResave.find((s) => s.id === 'x');
  ok(!!stillClosed && stillClosed.closed === true, 'save() preserves the closed flag across a resave — a background/queued turn must not silently reopen an archived chat');
  ok(stillClosed!.title === 'Chat X — updated', 'save() still updates the title/content normally while preserving closed');

  await store2.setClosed('x', false);
  const afterReopen = await store2.listSessions();
  ok(afterReopen.find((s) => s.id === 'x')!.closed === false, 'setClosed(id, false) reopens a closed chat');

  await store2.setClosed('nonexistent-id', true);
  ok(true, 'setClosed() on an unknown id is a safe no-op (does not throw)');

  fs.rmSync(tmp2, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All ChatStore runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
