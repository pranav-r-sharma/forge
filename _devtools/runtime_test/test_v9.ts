// Runtime tests for the 0.9.1 round: hierarchical chat-persistence hardening
// requested as a follow-up to 0.9.0's corrupted-chat recovery ("how can you
// ensure I don't lose chats going forward" -> "implement all in hierarchical
// fashion without introducing new bugs"). Covers, in the same order they're
// implemented in ChatStore (src/forge/chatStore.ts):
//   1. Validate-before-commit in saveInternal() — a bad write must not
//      clobber the previously-good file.
//   2. Backup rotation (<id>.json.bak) in saveInternal() — including the
//      "must not overwrite a good .bak with corrupt bytes" fix that came out
//      of designing this (see testBackupRotationDoesNotSelfCorrupt below).
//   3. The 4-tier recoverCorruptedSession() hierarchy: .tmp -> .bak ->
//      crash-log reconstruction -> empty shell, and tier precedence when
//      more than one is available.
//   4. exportAllChatsCommand() (src/commands.ts).
// The existing test_v8.ts / test_chatstore.ts corrupted-session and
// save/delete scenarios were re-run unmodified against this same code and
// still pass in full (85/85 and 16/16 respectively) — see the delivery
// notes; that's the regression check for this round, not duplicated here.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatStore, StoredSession, LogEntry } from '../../src/forge/chatStore';
import { exportAllChatsCommand } from '../../src/commands';

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v9-test-'));
  return vscode.Uri.file(tmp);
}

function makeStoredSession(id: string, title: string): StoredSession {
  const now = new Date().toISOString();
  return { id, title, mode: 'agent', model: 'fake-model', createdAt: now, updatedAt: now, uiHistory: [], modelHistory: [] };
}

function chatDirFor(root: vscode.Uri): string {
  return vscode.Uri.joinPath(root, '.forge', 'chat').fsPath;
}

async function testValidateBeforeCommit() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const id = store.newId();
  const dir = chatDirFor(root);

  await store.save(makeStoredSession(id, 'v1'));
  const targetPath = path.join(dir, `${id}.json`);
  const v1OnDisk = fs.readFileSync(targetPath, 'utf8');
  ok(JSON.parse(v1OnDisk).title === 'v1', 'sanity: v1 actually landed on disk before the corrupted-write test');

  // Monkey-patch workspace.fs.writeFile so the NEXT write to this session's
  // .tmp file lands garbage bytes instead of the real serialized session —
  // simulating a filesystem-level fault that writeFile() itself doesn't
  // surface as an error (still resolves normally).
  const originalWriteFile = vscode.workspace.fs.writeFile.bind(vscode.workspace.fs);
  let corruptNext = true;
  (vscode.workspace.fs as any).writeFile = async (uri: any, bytes: any) => {
    if (corruptNext && uri.fsPath.endsWith(`${id}.json.tmp`)) {
      corruptNext = false;
      return originalWriteFile(uri, Buffer.from('{ this will not parse', 'utf8'));
    }
    return originalWriteFile(uri, bytes);
  };
  try {
    await store.save(makeStoredSession(id, 'v2 (should be rejected)'));
  } finally {
    (vscode.workspace.fs as any).writeFile = originalWriteFile;
  }

  const afterBadSave = fs.readFileSync(targetPath, 'utf8');
  ok(JSON.parse(afterBadSave).title === 'v1', 'a save whose .tmp fails to validate leaves the previously-saved content untouched (still v1, not v2)');
  ok(!fs.existsSync(path.join(dir, `${id}.json.tmp`)), 'the garbage .tmp file left behind by the rejected write is cleaned up, not left dangling');

  // A normal save afterwards must still work fine — the rejection must not
  // wedge the store.
  await store.save(makeStoredSession(id, 'v3 (should succeed)'));
  const afterGoodSave = fs.readFileSync(targetPath, 'utf8');
  ok(JSON.parse(afterGoodSave).title === 'v3 (should succeed)', 'a subsequent normal save succeeds after a prior save was rejected by validation');
}

async function testBackupRotation() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const id = store.newId();
  const dir = chatDirFor(root);
  const bakPath = path.join(dir, `${id}.json.bak`);

  await store.save(makeStoredSession(id, 'gen1'));
  ok(!fs.existsSync(bakPath), 'no .bak exists yet after only one save — nothing to roll back to');

  await store.save(makeStoredSession(id, 'gen2'));
  ok(fs.existsSync(bakPath), '.bak appears after the second save');
  const bak1 = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
  ok(bak1.title === 'gen1', '.bak holds the PRIOR generation (gen1), not the one that was just saved (gen2)');

  await store.save(makeStoredSession(id, 'gen3'));
  const bak2 = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
  ok(bak2.title === 'gen2', '.bak rolls forward on every save — now holds gen2 (one generation behind the current gen3)');

  // Now actually use it for recovery: corrupt the live file with no .tmp
  // present, confirm load() falls back to the .bak tier and gets gen2 back
  // (not gen3, and not an empty shell).
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ corrupt, no tmp present');
  const recovered = await store.load(id);
  ok(!!recovered && recovered.title === 'gen2', `corrupt live file + no .tmp recovers from .bak, getting gen2 back (got ${JSON.stringify(recovered?.title)})`);
}

async function testBackupRotationDoesNotSelfCorrupt() {
  // This pins the fix for a bug this round's design caught before it shipped:
  // recoverCorruptedSession() re-persists recovered content by calling
  // saveInternal() again, and saveInternal()'s backup-rotation step reads
  // whatever is CURRENTLY at `target` to roll into .bak. At the moment a
  // recovery is happening, `target` IS the known-corrupt file — if backup
  // rotation blindly copied it, it would silently overwrite a previously
  // GOOD .bak with garbage, destroying tier 2 for any future recovery.
  // saveInternal() now only rotates a backup when the current target itself
  // parses as valid JSON.
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const id = store.newId();
  const dir = chatDirFor(root);
  const bakPath = path.join(dir, `${id}.json.bak`);

  await store.save(makeStoredSession(id, 'gen1')); // no .bak yet
  await store.save(makeStoredSession(id, 'gen2')); // .bak now holds gen1
  const bakBefore = fs.readFileSync(bakPath, 'utf8');
  ok(JSON.parse(bakBefore).title === 'gen1', 'sanity: .bak holds gen1 before the corruption/recovery round-trip');

  // Corrupt the live file (simulating gen2 getting damaged) — .bak (gen1) is
  // still good at this point.
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ gen2 is now corrupt, no tmp present');

  const recovered = await store.load(id); // tier 2 (.bak) kicks in, recovers gen1, re-persists it
  ok(!!recovered && recovered.title === 'gen1', 'recovery via .bak returns gen1 as expected');

  const bakAfter = fs.readFileSync(bakPath, 'utf8');
  let bakAfterParses = true;
  try {
    JSON.parse(bakAfter);
  } catch {
    bakAfterParses = false;
  }
  ok(bakAfterParses, '.bak still parses as valid JSON after the recovery round-trip — the re-persist did not clobber it with corrupt bytes read from the (corrupt) target it recovered from');
}

async function testTmpTakesPrecedenceOverBak() {
  // With both a leftover .tmp and a rolling .bak available, tier 1 (.tmp)
  // must win — it's the more recent of the two.
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const id = store.newId();
  const dir = chatDirFor(root);

  await store.save(makeStoredSession(id, 'gen1'));
  await store.save(makeStoredSession(id, 'gen2')); // .bak now holds gen1
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ live file corrupt');
  fs.writeFileSync(path.join(dir, `${id}.json.tmp`), JSON.stringify(makeStoredSession(id, 'from-tmp')));

  const recovered = await store.load(id);
  ok(!!recovered && recovered.title === 'from-tmp', `when both .tmp and .bak are available, tier 1 (.tmp) wins over tier 2 (.bak) (got ${JSON.stringify(recovered?.title)})`);
}

async function testLogReconstruction() {
  const root = freshWorkspace();
  const store = new ChatStore(root);
  const id = store.newId();
  const dir = chatDirFor(root);

  // Only ONE save — so no .bak was ever written for this session, matching
  // the realistic worst case this tier exists for (an old session saved
  // before this hardening shipped, or one that only ever got one turn).
  await store.save(makeStoredSession(id, 'log-recovery title'));

  const entries: LogEntry[] = [
    { ts: new Date().toISOString(), kind: 'user', detail: 'What does parseConfig() do?' },
    { ts: new Date().toISOString(), kind: 'tool_call', detail: 'read_file({"path":"src/config.ts"})' },
    { ts: new Date().toISOString(), kind: 'final', detail: 'It reads config.json, validates required fields, and returns a typed Config object.' },
    { ts: new Date().toISOString(), kind: 'error', detail: 'Ollama request timed out after 30s' },
    { ts: new Date().toISOString(), kind: 'checkpoint', detail: 'checkpoint set before edit to src/config.ts' },
  ];
  for (const e of entries) await store.appendLog(id, e);

  // Corrupt the live file; no .tmp, no .bak.
  fs.writeFileSync(path.join(dir, `${id}.json`), '{ corrupt, no tmp, no bak');
  ok(!fs.existsSync(path.join(dir, `${id}.json.tmp`)), 'sanity: no .tmp present for this test');
  ok(!fs.existsSync(path.join(dir, `${id}.json.bak`)), 'sanity: no .bak present for this test (only one save ever happened)');

  const loaded = await store.load(id);
  ok(!!loaded, 'tier 3 (crash-log reconstruction) returns a usable session when tiers 1 and 2 are both unavailable');
  ok(loaded!.uiHistory[0]?.kind === 'warning', 'the reconstructed transcript opens with a disclaimer bubble explaining it was rebuilt from the crash log');
  ok(
    loaded!.uiHistory.some((e: any) => e.kind === 'user' && e.text === 'What does parseConfig() do?'),
    'the logged user entry became a user chat bubble'
  );
  ok(
    loaded!.uiHistory.some((e: any) => e.kind === 'assistant' && e.text.includes('typed Config object')),
    'the logged final entry became an assistant chat bubble'
  );
  ok(
    loaded!.uiHistory.some((e: any) => e.kind === 'error' && e.text.includes('timed out')),
    'the logged error entry became an error bubble'
  );
  ok(
    loaded!.uiHistory.some((e: any) => e.kind === 'system' && e.text.startsWith('[tool_call]')),
    'a log entry kind with no direct chat-bubble equivalent (tool_call) becomes a labeled system note'
  );
  ok(
    loaded!.uiHistory.some((e: any) => e.kind === 'system' && e.text.startsWith('[checkpoint]')),
    'checkpoint log entries also become labeled system notes'
  );

  // Recovered content is saved back — a second load reads it straight off
  // disk without needing to reconstruct again.
  const reloaded = await store.load(id);
  ok(!!reloaded && reloaded.uiHistory.length === loaded!.uiHistory.length, 'the reconstructed transcript was persisted — a second load returns the same content directly, not a second reconstruction');
}

async function testExportAllChats() {
  const originalShowSaveDialog = (vscode.window as any).showSaveDialog;
  const originalShowInfo = (vscode.window as any).showInformationMessage;

  // ---------- nothing to export ----------
  {
    const root = freshWorkspace();
    const store = new ChatStore(root);
    let dialogCalled = false;
    const messages: string[] = [];
    (vscode.window as any).showSaveDialog = async () => {
      dialogCalled = true;
      return undefined;
    };
    (vscode.window as any).showInformationMessage = (msg: string) => messages.push(msg);

    await exportAllChatsCommand(store, '0.9.1');
    ok(!dialogCalled, 'export with zero saved chats never even shows the save dialog');
    ok(messages.some((m) => m.includes('no saved chats')), 'export with zero saved chats tells the user there was nothing to export');
  }

  // ---------- normal export, including opportunistic repair of a corrupted chat ----------
  {
    const root = freshWorkspace();
    const store = new ChatStore(root);
    const dir = chatDirFor(root);
    const id1 = store.newId();
    const id2 = store.newId();
    await store.save(makeStoredSession(id1, 'healthy chat'));
    await store.save(makeStoredSession(id2, 'chat that will be corrupted'));
    // Corrupt id2 with nothing to recover from except index.json's title —
    // export should still succeed and repair it to an empty shell as a
    // side effect of calling load() on every session.
    fs.writeFileSync(path.join(dir, `${id2}.json`), '{ corrupt for export test');

    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v9-export-')), 'bundle.json');
    let savedUri: any;
    (vscode.window as any).showSaveDialog = async () => {
      savedUri = vscode.Uri.file(outFile);
      return savedUri;
    };
    const messages: string[] = [];
    (vscode.window as any).showInformationMessage = (msg: string) => messages.push(msg);

    await exportAllChatsCommand(store, '0.9.1');

    ok(fs.existsSync(outFile), 'export writes the bundle to the path returned by the save dialog');
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    ok(bundle.forgeVersion === '0.9.1', 'the bundle records the Forge version that produced it');
    ok(typeof bundle.exportedAt === 'string' && bundle.exportedAt.length > 0, 'the bundle records an export timestamp');
    ok(Array.isArray(bundle.sessions) && bundle.sessions.length === 2, `the bundle includes both sessions (got ${bundle.sessions?.length})`);
    ok(bundle.sessions.some((s: StoredSession) => s.title === 'healthy chat'), 'the healthy session is exported with its real content');
    ok(
      bundle.sessions.some((s: StoredSession) => s.id === id2 && s.uiHistory.some((e: any) => e.kind === 'error')),
      'the corrupted session is still exported — as its recovered (empty-shell) form, not skipped'
    );
    ok(messages.some((m) => m.includes('exported 2 chat')), 'the success message reports how many chats were exported');

    // The opportunistic-repair side effect: id2's on-disk file should now
    // be the valid recovered shell, not the original corrupt bytes.
    const id2OnDiskNow = fs.readFileSync(path.join(dir, `${id2}.json`), 'utf8');
    let id2Parses = true;
    try {
      JSON.parse(id2OnDiskNow);
    } catch {
      id2Parses = false;
    }
    ok(id2Parses, "exporting also repairs a corrupted chat's on-disk file, since export loads every session through the normal recovery path");
  }

  // ---------- user cancels the save dialog ----------
  {
    const root = freshWorkspace();
    const store = new ChatStore(root);
    await store.save(makeStoredSession(store.newId(), 'irrelevant'));
    (vscode.window as any).showSaveDialog = async () => undefined;
    let infoCalled = false;
    (vscode.window as any).showInformationMessage = () => {
      infoCalled = true;
    };
    await exportAllChatsCommand(store, '0.9.1');
    ok(!infoCalled, 'cancelling the save dialog exits quietly without a follow-up "exported" message');
  }

  (vscode.window as any).showSaveDialog = originalShowSaveDialog;
  (vscode.window as any).showInformationMessage = originalShowInfo;
}

async function main() {
  await testValidateBeforeCommit();
  await testBackupRotation();
  await testBackupRotationDoesNotSelfCorrupt();
  await testTmpTakesPrecedenceOverBak();
  await testLogReconstruction();
  await testExportAllChats();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.9.1 (hierarchical chat-persistence hardening) runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
