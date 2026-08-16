// Runtime tests for the memory system: MemoryStore (.forge/memory.md, the
// durable-facts half) and ChatMemoryIndex (semantic search over past chat
// history, the retrieval half). MemoryStore uses the fake `vscode` fs shim
// (real filesystem underneath, see node_modules/vscode/index.js);
// ChatMemoryIndex's chunking/extraction helpers are plain data logic and are
// exercised directly, plus its search() with a fake OllamaClient to cover
// both the embeddings path and the keyword-fallback path.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryStore } from '../../src/forge/memory';
import { ChatMemoryIndex, chunkText, extractSearchableText } from '../../src/indexing/chatMemoryIndex';
import { StoredSession } from '../../src/forge/chatStore';

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

function fakeStoredSession(id: string, title: string, texts: { kind: 'user' | 'assistant'; text: string }[]): StoredSession {
  return {
    id,
    title,
    mode: 'agent',
    model: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    uiHistory: texts.map((t, i) => ({ kind: t.kind, id: `${id}_${i}`, text: t.text }) as any),
    modelHistory: [],
  };
}

async function main() {
  // ---------- MemoryStore ----------
  const root = vscode.Uri.file(path.resolve(__dirname, 'fixtures/memroot'));
  fs.rmSync(path.join(root.fsPath, '.forge'), { recursive: true, force: true });

  const store = new MemoryStore(root);
  ok((await store.renderForPrompt()) === '', 'renderForPrompt() is empty when no memory file exists yet');

  const first = await store.addFact('This repo uses pnpm, not npm.');
  ok(first.added === true, 'addFact() adds a brand-new fact');

  const dup = await store.addFact('this repo uses pnpm, not npm.  ');
  ok(dup.added === false, 'addFact() de-dupes case-insensitively and ignores whitespace differences');

  await store.addFact('The user prefers tabs over spaces.');
  const rendered = await store.renderForPrompt();
  ok(rendered.includes('pnpm') && rendered.includes('tabs over spaces'), 'renderForPrompt() includes every distinct remembered fact');
  ok(rendered.startsWith('## Remembered facts'), 'renderForPrompt() is a labeled section ready to splice into the system prompt');

  const raw = await store.readRaw();
  ok(raw.split('\n').filter((l) => l.trim()).length === 2, 'exactly 2 facts persisted to disk despite 3 addFact() calls (the duplicate was rejected)');

  // Cap behavior: many long facts should get capped, keeping the most recent.
  const bigStore = new MemoryStore(vscode.Uri.file(path.resolve(__dirname, 'fixtures/memroot_big')));
  fs.rmSync(path.join(bigStore.fsPath(), '..'), { recursive: true, force: true });
  for (let i = 0; i < 200; i++) {
    await bigStore.addFact(`Fact number ${i}: ${'x'.repeat(40)}`);
  }
  const bigRendered = await bigStore.renderForPrompt();
  ok(bigRendered.length <= 4200, 'renderForPrompt() stays bounded even with a very large memory file');
  ok(bigRendered.includes('Fact number 199'), 'renderForPrompt() keeps the MOST RECENT facts when trimming to the cap, not the oldest');
  ok(bigRendered.includes('older fact(s) omitted'), 'renderForPrompt() notes when older facts were omitted rather than silently dropping them');

  // ---------- chunkText ----------
  const chunks = chunkText('line one\nline two\nline three', 100);
  ok(chunks.length === 1 && chunks[0].includes('line three'), 'chunkText() keeps short text in a single chunk');

  const longLines = Array.from({ length: 20 }, (_, i) => `paragraph ${i} `.repeat(3)).join('\n');
  const manyChunks = chunkText(longLines, 80);
  ok(manyChunks.length > 1, 'chunkText() splits long text into multiple budget-sized chunks');
  ok(manyChunks.every((c) => c.length <= 80 + 40), 'chunkText() chunks stay roughly within budget (allowing one line to slightly overshoot)');
  ok(manyChunks.join('\n').split('\n').filter(Boolean).length === longLines.split('\n').filter(Boolean).length, 'chunkText() does not drop any non-empty line while splitting');

  // ---------- extractSearchableText ----------
  const stored = fakeStoredSession('sess_1', 'Auth refactor', [
    { kind: 'user', text: 'Why did we switch away from the old auth flow?' },
    { kind: 'assistant', text: 'Because the old flow leaked tokens in query strings.' },
  ]);
  const text = extractSearchableText(stored);
  ok(text.includes('USER: Why did we switch'), 'extractSearchableText() prefixes user turns with USER:');
  ok(text.includes('ASSISTANT: Because the old flow'), 'extractSearchableText() prefixes assistant turns with ASSISTANT:');

  // ---------- ChatMemoryIndex: keyword fallback (no embedding model) ----------
  const noEmbedOllama = { embed: async () => undefined } as any;
  const kwIndex = new ChatMemoryIndex(noEmbedOllama, undefined, () => 'nomic-embed-text');
  await kwIndex.indexSession(stored);
  const kwResults = await kwIndex.search('auth tokens', 5);
  ok(kwResults.length > 0, 'ChatMemoryIndex falls back to keyword search and still finds a match when no embedding model is available');
  ok(kwResults[0].sessionId === 'sess_1', 'keyword search result correctly attributes the match back to its source session');

  const kwNoMatch = await kwIndex.search('completely unrelated quantum physics topic', 5);
  ok(kwNoMatch.length === 0, 'keyword search returns nothing for a query with no term overlap');

  // ---------- ChatMemoryIndex: embeddings path + incremental re-indexing ----------
  let embedCalls = 0;
  const fakeVec = (s: string): number[] => {
    // Deterministic "embedding": character-code histogram bucketed into 8 dims.
    const v = new Array(8).fill(0);
    for (const ch of s) v[ch.charCodeAt(0) % 8] += 1;
    return v;
  };
  const embedOllama = {
    embed: async (_model: string, input: string) => {
      embedCalls++;
      return fakeVec(input);
    },
  } as any;
  const embedIndex = new ChatMemoryIndex(embedOllama, undefined, () => 'nomic-embed-text');
  await embedIndex.indexSession(stored);
  const callsAfterFirstIndex = embedCalls;
  ok(callsAfterFirstIndex > 0, 'indexSession() embeds at least one chunk when an embedding model is available');

  // Re-indexing the SAME session content must not re-embed anything.
  await embedIndex.indexSession(stored);
  ok(embedCalls === callsAfterFirstIndex, 'indexSession() skips re-embedding a session whose extracted text has not changed (content-hash gate)');

  // Changing the session's content DOES trigger re-embedding.
  const stored2 = fakeStoredSession('sess_1', 'Auth refactor', [
    ...([{ kind: 'user', text: 'Why did we switch away from the old auth flow?' }, { kind: 'assistant', text: 'Because the old flow leaked tokens in query strings.' }] as any),
    { kind: 'user', text: 'One more follow-up question about token expiry.' },
  ]);
  await embedIndex.indexSession(stored2);
  ok(embedCalls > callsAfterFirstIndex, 'indexSession() re-embeds once the session content actually changes');

  const semanticResults = await embedIndex.search('auth tokens', 5);
  ok(semanticResults.length > 0, 'ChatMemoryIndex.search() returns ranked results via the embeddings path when an embedding model is available');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All memory-system runtime tests passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
