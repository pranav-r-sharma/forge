// Runtime tests for the 0.3.0 additions that don't need the `vscode` shim —
// loop detection, checkpoint restore math, hallucination-claim checking, and
// context pruning/compaction are all plain-data logic, so they're exercised
// directly here rather than through the fake extension host.
import { LoopDetector, signatureForStep } from '../../src/agent/loopDetector';
import { CheckpointStore } from '../../src/agent/checkpoints';
import { extractClaimedPaths, wasEverWritten, findUnverifiedClaims } from '../../src/agent/claimChecker';
import { pruneStaleReadsView, hardCapOversizedMessages, compactionThreshold, maybeCompact } from '../../src/agent/contextManager';
import { ChatMessage } from '../../src/ollama/types';

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

// ---------- loopDetector ----------
{
  const d = new LoopDetector({ consecutiveLimit: 3, windowSize: 8, windowLimit: 4 });
  let last;
  for (let i = 0; i < 2; i++) last = d.record(signatureForStep('run_command', { command: 'npm test' }, false, 'Error: still failing'));
  ok(!last!.looping, 'two identical failures in a row do not yet trip the detector');
  last = d.record(signatureForStep('run_command', { command: 'npm test' }, false, 'Error: still failing'));
  ok(last!.looping === true, 'three identical failures in a row trips the consecutive-repeat detector');

  const d2 = new LoopDetector({ consecutiveLimit: 100, windowSize: 8, windowLimit: 3 });
  const sigA = signatureForStep('read_file', { path: 'a.ts' }, true, 'ok content A');
  const sigB = signatureForStep('read_file', { path: 'b.ts' }, true, 'ok content B');
  d2.record(sigA);
  d2.record(sigB);
  d2.record(sigA);
  d2.record(sigB);
  const windowResult = d2.record(sigA);
  ok(windowResult.looping === true, 'alternating repeats within the window trip the windowed detector even without consecutive repeats');

  const d3 = new LoopDetector();
  const distinct = d3.record(signatureForStep('write_file', { path: 'x.ts', content: '1' }, true, 'Updated x.ts.'));
  ok(!distinct.looping, 'a single call never looks like a loop');
}

// ---------- checkpoints ----------
{
  const store = new CheckpointStore();
  store.begin({ id: 'ckpt_1', label: 'first turn', createdAt: 't1', uiHistoryIndex: 0, modelHistoryLength: 1 });
  store.recordBeforeWrite('a.ts', 'original A'); // first touch of a.ts this epoch
  store.recordBeforeWrite('a.ts', 'SHOULD BE IGNORED - already recorded'); // second write same epoch, must not overwrite
  store.begin({ id: 'ckpt_2', label: 'second turn', createdAt: 't2', uiHistoryIndex: 4, modelHistoryLength: 6 });
  store.recordBeforeWrite('b.ts', null); // b.ts created fresh in this epoch (didn't exist before)
  store.recordBeforeWrite('a.ts', 'state of a.ts after epoch 1'); // a.ts touched again in epoch 2

  const resolvedToFirst = store.resolveRestore('ckpt_1');
  ok(!!resolvedToFirst, 'resolveRestore finds an existing checkpoint');
  ok(resolvedToFirst!.fileStates['a.ts'] === 'original A', 'restoring to ckpt_1 recovers a.ts as it was before ANY edit (not the epoch-2 intermediate value)');
  ok(resolvedToFirst!.fileStates['b.ts'] === null, 'restoring to ckpt_1 says b.ts should be deleted (it did not exist yet at that point)');

  const resolvedToSecond = store.resolveRestore('ckpt_2');
  ok(resolvedToSecond!.fileStates['a.ts'] === 'state of a.ts after epoch 1', 'restoring to ckpt_2 only rewinds a.ts to its state entering epoch 2, not all the way to epoch 1');
  ok(!('b.ts' in resolvedToSecond!.fileStates) === false && resolvedToSecond!.fileStates['b.ts'] === null, 'restoring to ckpt_2 still deletes b.ts (created during that epoch)');

  const applied = store.applyRestore('ckpt_1');
  ok(!!applied, 'applyRestore succeeds for an existing checkpoint');
  ok(store.list().length === 1 && store.list()[0].id === 'ckpt_1', 'applyRestore drops every checkpoint after the restored one');
  ok(store.resolveRestore('ckpt_2') === undefined, 'a checkpoint that was rewound past can no longer be restored to');

  const missing = new CheckpointStore().resolveRestore('nope');
  ok(missing === undefined, 'resolveRestore returns undefined for an unknown id instead of throwing');
}

// ---------- claimChecker ----------
{
  const claims = extractClaimedPaths('I created `src/foo.ts` and updated `README.md` for you. Also considered `bar.py` but did not touch it.');
  ok(claims.includes('src/foo.ts') && claims.includes('README.md'), 'extractClaimedPaths finds backtick-quoted paths after a change verb');
  ok(!claims.includes('bar.py'), 'extractClaimedPaths ignores a path mentioned without a preceding change verb');

  const history: ChatMessage[] = [
    { role: 'assistant', content: '```forge_action\n{"tool":"write_file","args":{"path":"src/foo.ts","content":"x"}}\n```' },
    { role: 'user', content: '[Tool "write_file" result]\nCreated src/foo.ts.' },
  ];
  ok(wasEverWritten('src/foo.ts', history), 'wasEverWritten finds a path that genuinely went through write_file');
  ok(!wasEverWritten('README.md', history), 'wasEverWritten does not find a path that was never actually written');

  const finalText = 'Done — I created `src/foo.ts` and updated `README.md` with the new section.';
  const unverified = findUnverifiedClaims(finalText, history);
  ok(unverified.length === 1 && unverified[0] === 'README.md', 'findUnverifiedClaims flags exactly the claimed-but-never-written path, not the one that was actually written');
}

// ---------- contextManager: pruneStaleReadsView ----------
{
  function toolCallMsg(tool: string, args: Record<string, any>): ChatMessage {
    return { role: 'assistant', content: '```forge_action\n' + JSON.stringify({ tool, args }) + '\n```' };
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read foo then bar' },
    toolCallMsg('read_file', { path: 'foo.ts' }),
    { role: 'user', content: '[Tool "read_file" result]\nfoo.ts content v1' },
    toolCallMsg('write_file', { path: 'foo.ts', content: 'v2' }),
    { role: 'user', content: '[Tool "write_file" result]\nUpdated foo.ts.' },
    toolCallMsg('read_file', { path: 'bar.ts' }),
    { role: 'user', content: '[Tool "read_file" result]\nbar.ts content' },
  ];
  const original = messages.map((m) => m.content);
  const pruned = pruneStaleReadsView(messages);
  ok(messages.every((m, i) => m.content === original[i]), 'pruneStaleReadsView never mutates the input array (archival transcript stays intact)');
  ok(pruned[3].content.includes('superseded') && pruned[3].content.includes('written'), 'the read of foo.ts before it was written is pruned as stale');
  ok(pruned[7].content === 'bar.ts content'.length ? true : pruned[7].content.includes('bar.ts content'), 'the still-current read of bar.ts is left alone');

  // Two reads of the same path: only the earlier one is superseded.
  const messages2: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    toolCallMsg('read_file', { path: 'x.ts' }),
    { role: 'user', content: '[Tool "read_file" result]\nx v1' },
    { role: 'assistant', content: 'thinking...' },
    toolCallMsg('read_file', { path: 'x.ts' }),
    { role: 'user', content: '[Tool "read_file" result]\nx v2 (latest)' },
  ];
  const pruned2 = pruneStaleReadsView(messages2);
  ok(pruned2[2].content.includes('superseded'), 'an older duplicate read of the same file is pruned');
  ok(pruned2[5].content === messages2[5].content, 'the newer read of the same file survives untouched');
}

// ---------- contextManager: hardCapOversizedMessages ----------
{
  const big = 'x'.repeat(30000);
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: big },
    { role: 'assistant', content: 'short' },
    { role: 'user', content: big }, // last message — must be protected
  ];
  const capped = hardCapOversizedMessages(messages);
  ok(capped[1].content.length < big.length, 'an oversized message in the middle of the transcript is truncated');
  ok(capped[1].content.includes('trimmed to save context'), 'the truncated message explains that it was trimmed');
  ok(capped[3].content === big, 'the very last message is never truncated, even if oversized — the model needs to see what it just got');
  ok(capped[0].content === 'sys', 'small messages pass through unchanged');
}

// ---------- contextManager: compactionThreshold + maybeCompact ----------
{
  ok(compactionThreshold(8192) === 40000, 'compactionThreshold floors at the minimum budget for a small context window');
  ok(compactionThreshold(262144) < 600000, 'compactionThreshold ceilings out rather than growing unbounded for a huge context window');
  ok(compactionThreshold(32768) > compactionThreshold(8192), 'a bigger configured context window allows a bigger uncompacted prompt');
}

async function asyncTests() {
  const fakeOllama = {
    chat: async () => 'SUMMARY: explored the repo, edited foo.ts, task is 80% done.',
  } as any;

  const longMessages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) {
    longMessages.push({ role: 'user', content: `turn ${i}: ` + 'y'.repeat(3000) });
    longMessages.push({ role: 'assistant', content: `ack ${i}` });
  }
  const originalLength = longMessages.length;
  const originalFirstContent = longMessages[1].content;

  const result = await maybeCompact(longMessages, undefined, 'test-model', 8192, fakeOllama);
  ok(longMessages.length === originalLength && longMessages[1].content === originalFirstContent, 'maybeCompact never mutates the archival array it was given — only returns a trimmed view');
  ok(result.promptMessages.length < longMessages.length, 'the returned prompt view is smaller than the full archival transcript once it is over budget');
  ok(result.promptMessages.some((m) => m.content.includes('Earlier conversation summary')), 'the prompt view includes a summary message standing in for the folded-away turns');
  ok(!!result.cache, 'maybeCompact returns a cache the caller can reuse on the next iteration');

  const second = await maybeCompact(longMessages, result.cache, 'test-model', 8192, {
    chat: async () => {
      throw new Error('should not be called again — cache should be reused');
    },
  } as any);
  ok(second.promptMessages.length === result.promptMessages.length, 'a cached compaction is reused (no new summarization call) when nothing new has crossed the threshold');

  const short: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const shortResult = await maybeCompact(short, undefined, 'test-model', 32768, fakeOllama);
  ok(shortResult.promptMessages === short, 'a short conversation well under budget is returned as-is, untouched');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.3.0 runtime tests passed.');
}

asyncTests();
