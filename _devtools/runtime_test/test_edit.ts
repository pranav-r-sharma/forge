import * as vscode from 'vscode';
import * as path from 'path';
import { PendingEditManager } from '../../src/tools/editApply';

function assert(cond: any, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
}

async function main() {
  const root = vscode.Uri.file(path.resolve(__dirname, 'fixtures/proj'));
  const fileUri = vscode.Uri.joinPath(root, 'foo.ts');

  // 1. Propose with approval required -> should NOT touch disk, overlay should reflect new content.
  const mgr = new PendingEditManager(root);
  // Item #3 (checkpoints) depends entirely on onBeforeWrite firing with the
  // TRUE pre-write disk content at the moment a write actually lands, not
  // at propose() time (which may be well before the user accepts, or may
  // never happen if requireApproval=false skips staging). Capture every
  // firing so the assertions below can check both "when" and "what".
  const beforeWriteEvents: { relPath: string; priorContent: string | null }[] = [];
  mgr.onBeforeWrite((relPath, priorContent) => beforeWriteEvents.push({ relPath, priorContent }));

  const original = require('fs').readFileSync(fileUri.fsPath, 'utf8');
  const proposed = original.replace('return 1;', 'return 2;');
  const { id, applied } = await mgr.propose(
    { uri: fileUri, relativePath: 'foo.ts', originalText: original, newText: proposed, kind: 'modify' },
    true
  );
  assert(applied === false, 'propose() with requireApproval=true does not apply immediately');
  const diskAfterPropose = require('fs').readFileSync(fileUri.fsPath, 'utf8');
  assert(diskAfterPropose === original, 'disk content unchanged while edit is pending');
  const effective = await mgr.readEffective(fileUri);
  assert(effective === proposed, 'readEffective() returns the overlay (proposed) content while pending');
  assert(mgr.hasPending() === true, 'hasPending() true after propose');

  // 2. A second proposal for the SAME path supersedes the first.
  const proposed2 = original.replace('return 1;', 'return 3;');
  const second = await mgr.propose(
    { uri: fileUri, relativePath: 'foo.ts', originalText: proposed, newText: proposed2, kind: 'modify' },
    true
  );
  assert(mgr.listSerialized().length === 1, 'second proposal for same path supersedes the first (still only 1 pending)');
  const effective2 = await mgr.readEffective(fileUri);
  assert(effective2 === proposed2, 'readEffective() reflects the superseding proposal');
  assert(beforeWriteEvents.length === 0, 'onBeforeWrite has NOT fired yet — nothing has actually hit disk, only staged (checkpoints must not capture at propose() time)');

  // 3. Accept -> writes to disk, clears pending.
  const accepted = await mgr.accept(second.id);
  assert(accepted === true, 'accept() returns true for a known id');
  const diskAfterAccept = require('fs').readFileSync(fileUri.fsPath, 'utf8');
  assert(diskAfterAccept === proposed2, 'disk content updated after accept()');
  assert(mgr.hasPending() === false, 'hasPending() false after accept');
  assert(beforeWriteEvents.length === 1, 'onBeforeWrite fires exactly once, at accept() — the actual disk-write moment');
  assert(beforeWriteEvents[0].relPath === 'foo.ts' && beforeWriteEvents[0].priorContent === original, 'onBeforeWrite reports the true pre-write disk content (the original fixture, not the staged proposal that never touched disk)');

  // 4. Reject path: propose again, reject, disk must remain untouched.
  const proposed3 = proposed2.replace('return 3;', 'return 4;');
  const third = await mgr.propose(
    { uri: fileUri, relativePath: 'foo.ts', originalText: proposed2, newText: proposed3, kind: 'modify' },
    true
  );
  const rejected = mgr.reject(third.id);
  assert(rejected === true, 'reject() returns true for a known id');
  const diskAfterReject = require('fs').readFileSync(fileUri.fsPath, 'utf8');
  assert(diskAfterReject === proposed2, 'disk content unchanged after reject()');
  const effectiveAfterReject = await mgr.readEffective(fileUri);
  assert(effectiveAfterReject === proposed2, 'readEffective() falls back to disk after reject()');

  // 5. requireApproval=false -> writes through immediately.
  const proposed4 = proposed2.replace('return 3;', 'return 5;');
  const fourth = await mgr.propose(
    { uri: fileUri, relativePath: 'foo.ts', originalText: proposed2, newText: proposed4, kind: 'modify' },
    false
  );
  assert(fourth.applied === true, 'propose() with requireApproval=false applies immediately');
  const diskAfterAutoApply = require('fs').readFileSync(fileUri.fsPath, 'utf8');
  assert(diskAfterAutoApply === proposed4, 'disk content updated immediately when approval not required');
  assert(beforeWriteEvents.length === 2, 'onBeforeWrite also fires for an immediate (requireApproval=false, i.e. Auto mode) write, not just accept()');
  assert(beforeWriteEvents[1].priorContent === proposed2, 'that firing captures the disk content right before THIS write (proposed2, which reject() correctly left in place) — this is exactly what a checkpoint needs to undo an Auto-mode edit');

  // 6. A create (file did not exist before) reports priorContent === null.
  const newFileUri = vscode.Uri.joinPath(root, 'brand-new.ts');
  await mgr.propose({ uri: newFileUri, relativePath: 'brand-new.ts', originalText: '', newText: 'export const x = 1;', kind: 'create' }, false);
  assert(beforeWriteEvents.length === 3 && beforeWriteEvents[2].relPath === 'brand-new.ts' && beforeWriteEvents[2].priorContent === null, 'creating a brand-new file reports priorContent=null, which checkpoints.ts treats as "delete on restore"');
  require('fs').unlinkSync(newFileUri.fsPath);

  // restore fixture
  require('fs').writeFileSync(fileUri.fsPath, original);

  console.log('\nAll editApply runtime tests passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
