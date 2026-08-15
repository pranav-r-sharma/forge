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

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All ChatStore runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
