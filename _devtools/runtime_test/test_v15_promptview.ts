// ============================================================================
// 0.15.0 (P0-13): append-only prompt view (src/agent/contextManager.ts updatePromptView).
// MEASURED on Ornith/MLX: a prompt that only grows is ~93-94% served from the runtime's cache (~9x faster per step); rewriting ONE old message drops
// that to ~1%. The core property tested here: consecutive prompts are byte-identical up to the newest message, EXCEPT on the few deliberate,
// batched cleanup events — and those always make real progress (no thrashing), never touch the newest messages, never mutate the archive.
// ============================================================================
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  waterMarks, estimateTokens, updateCharsPerToken, singleMessageCapChars, capOversizedStable, staleReadIndices, updatePromptView,
  pruneStaleReadsView, maybeCompact, hardCapOversizedMessages, DEFAULT_CHARS_PER_TOKEN,
} from '../../src/agent/contextManager';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { TaskLedger } from '../../src/agent/taskLedger';
import { TraceWriter, tracePathFor } from '../../src/agent/traceLog';
import { ChatMessage } from '../../src/ollama/types';
import { AgentEvent } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}
const vs: any = vscode;

const readCall = (p: string, extra: any = {}) => '```forge_action\n' + JSON.stringify({ tool: 'read_file', args: { path: p, ...extra } }) + '\n```';
const writeCall = (p: string) => '```forge_action\n' + JSON.stringify({ tool: 'write_file', args: { path: p, search: 'a', replace: 'b' } }) + '\n```';
const result = (p: string, chars: number) => `[Tool "read_file" result]\n${p} (lines 1-100 of 100):\n${'x'.repeat(chars)}`;
const sys: ChatMessage = { role: 'system', content: 'SYSTEM PROMPT (frozen)' };
const task: ChatMessage = { role: 'user', content: 'ORIGINAL USER REQUEST: refactor the handlers' };

function readConversation(nReads: number, chars: number): ChatMessage[] {
  const m: ChatMessage[] = [sys, task];
  for (let i = 0; i < nReads; i++) m.push({ role: 'assistant', content: readCall(`f${i}.txt`) }, { role: 'user', content: result(`f${i}.txt`, chars) });
  return m;
}
const isExtension = (prev: ChatMessage[], next: ChatMessage[]) => next.length >= prev.length && prev.every((m, i) => next[i].role === m.role && next[i].content === m.content);
const snapshot = (m: ChatMessage[]) => JSON.stringify(m);
const fakeSummarizer = () => { const c = { calls: 0, chat: async () => { c.calls++; return 'SUMMARY OF EARLIER WORK'; } }; return c as any; };

function testHelpers() {
  const w = waterMarks(32768);
  ok(w.highTokens === 24576 && w.lowTokens === 14745, `water marks default to 75% / 45% of the window (got ${w.highTokens}/${w.lowTokens})`);
  const bad = waterMarks(10000, 99, 99);
  ok(bad.highTokens <= 9500 && bad.lowTokens < bad.highTokens, 'absurd percentages are clamped and low stays below high');
  ok(waterMarks(0).highTokens > 0, 'a missing window falls back to a sane default');
  ok(estimateTokens(3000, 3) === 1000 && estimateTokens(3000, 0) === estimateTokens(3000, DEFAULT_CHARS_PER_TOKEN), 'estimateTokens divides by chars/token, defaulting sanely');
  ok(updateCharsPerToken(undefined, 100, 10) === DEFAULT_CHARS_PER_TOKEN, 'a tiny prompt is ignored (too noisy)');
  ok(updateCharsPerToken(3, 10000, 4000) < 3 && updateCharsPerToken(3, 10000, 4000) > 2.5, 'chars/token moves gradually toward the observation (EMA), not in one jump');
  ok(updateCharsPerToken(3, 10000, 100) === 3, 'an implausible reading (100 chars/token) is rejected');
  ok(updateCharsPerToken(3, 10000, undefined) === 3, 'no token count → unchanged');
  ok(singleMessageCapChars(32768) === 24576 && singleMessageCapChars(1000) === 12000, 'per-message cap at default 25%: 25% of the window, floored/ceilinged for numCtx ≤ ~37k');
  ok(singleMessageCapChars(10_000_000) === 7_500_000, 'per-message cap upper clamp scales with a very large context window');
  const big = 'y'.repeat(50_000);
  const a = capOversizedStable([sys, task, { role: 'user', content: big }], 20_000)[2].content;
  const b = capOversizedStable([sys, task, task, task, task, { role: 'user', content: big }], 20_000)[5].content;
  ok(a === b && a.length < 20_500 && /chars trimmed/.test(a), 'the cap is POSITION-INDEPENDENT: the same message is truncated identically wherever it sits (so it never changes after it was sent)');
  ok(capOversizedStable([{ role: 'system', content: big }, task], 20_000)[0].content === big, 'the system prompt is exempt from the cap');
}

function testStaleRules() {
  const c = readConversation(10, 100);
  const s = staleReadIndices(c);
  ok(s.length === 4 && s.every((x) => x.reason.includes('older')), `10 reads: the 4 older than the last 6 tool results are stale (got ${s.length})`);
  ok(staleReadIndices(c, 2).length === 8 && staleReadIndices(c, 0).length === 10, 'a smaller keep-recent count marks more reads stale (used by escalation)');
  const w = [sys, task, { role: 'assistant', content: readCall('a.txt') } as ChatMessage, { role: 'user', content: result('a.txt', 50) } as ChatMessage, { role: 'assistant', content: writeCall('a.txt') } as ChatMessage, { role: 'user', content: '[Tool "write_file" result]\nUpdated a.txt.' } as ChatMessage];
  const sw = staleReadIndices(w);
  ok(sw.length === 1 && /written after/.test(sw[0].reason), 'a read followed by a write to the same file is stale');
  const sup = [sys, task, { role: 'assistant', content: readCall('a.txt') } as ChatMessage, { role: 'user', content: result('a.txt', 50) } as ChatMessage, { role: 'assistant', content: readCall('a.txt') } as ChatMessage, { role: 'user', content: result('a.txt', 50) } as ChatMessage];
  const ss = staleReadIndices(sup);
  ok(ss.length === 1 && ss[0].idx === 3 && /newer read/.test(ss[0].reason), 'an earlier read superseded by a later read of the same file is stale');
  const chunked: ChatMessage[] = [sys, task];
  for (const [s, e] of [[1, 272], [273, 560], [560, 808], [808, 952]] as const) {
    chunked.push({ role: 'assistant', content: readCall('big.ts', { start_line: s, end_line: e }) }, { role: 'user', content: result('big.ts', 80) });
  }
  const chunkedStale = staleReadIndices(chunked, 10);
  ok(!chunkedStale.some((x) => /newer read/.test(x.reason)), 'chunked reads of one file are not masked as superseded by a later non-overlapping chunk');
  const reread = [
    sys, task,
    { role: 'assistant', content: readCall('a.txt', { start_line: 10, end_line: 50 }) } as ChatMessage,
    { role: 'user', content: result('a.txt', 50) } as ChatMessage,
    { role: 'assistant', content: readCall('a.txt', { start_line: 10, end_line: 50 }) } as ChatMessage,
    { role: 'user', content: result('a.txt', 50) } as ChatMessage,
  ];
  const rereadStale = staleReadIndices(reread, 10);
  ok(rereadStale.length === 1 && rereadStale[0].idx === 3 && /newer read/.test(rereadStale[0].reason), 'a full re-read of the same line range IS superseded');
  const err = [sys, task, { role: 'assistant', content: readCall('gone.txt') } as ChatMessage, { role: 'user', content: '[Tool "read_file" result]\nFile not found: gone.txt' } as ChatMessage];
  ok(staleReadIndices(err, 0).length === 1, 'a read result (even an error text) is a candidate only via the same rules');
  const already = readConversation(10, 100).map((m, i) => (i === 3 ? { ...m, content: '[Tool "read_file" result — superseded]\nf0.txt: x' } : m));
  ok(!staleReadIndices(already).some((x) => x.idx === 3), 'an already-stubbed result is not stubbed again');
}

async function testPrefixStabilityUnderHighWater() {
  const o = { model: 'm', numCtx: 65536, ollama: fakeSummarizer() };
  let state: any; let prev: ChatMessage[] | undefined; let allExt = true; let events = 0;
  const arch: ChatMessage[] = [sys, task];
  for (let k = 0; k < 40; k++) {
    arch.push({ role: 'assistant', content: readCall(`f${k}.txt`) }, { role: 'user', content: result(`f${k}.txt`, k === 20 ? 30_000 : 1500) }); // one oversized result in the middle
    const before = snapshot(arch);
    const r = await updatePromptView(arch, state, o);
    state = r.state;
    if (r.event) events++;
    if (prev && !isExtension(prev, r.view)) allExt = false;
    ok(snapshot(arch) === before || (failed++, false), 'archive untouched');
    prev = r.view;
  }
  ok(allExt && events === 0, `40 steps under the high-water mark: EVERY prompt is a byte-identical extension of the previous one, with zero rewrite events (events=${events})`);
  ok(prev![0] === sys, 'the frozen system message is passed through unchanged');
}

async function testFewEventsVersusLegacy() {
  const ollama = fakeSummarizer();
  const o = { model: 'm', numCtx: 16384, ollama };
  let state: any; let prev: ChatMessage[] | undefined; let breaks = 0; let events = 0; const arch: ChatMessage[] = [sys, task];
  let legacyPrev: ChatMessage[] | undefined; let legacyBreaks = 0; let legacyCache: any;
  for (let k = 0; k < 24; k++) {
    arch.push({ role: 'assistant', content: readCall(`f${k}.txt`) }, { role: 'user', content: result(`f${k}.txt`, 6000) });
    const r = await updatePromptView(arch, state, o);
    state = r.state;
    if (r.event) events++;
    if (prev && !isExtension(prev, r.view)) breaks++;
    prev = r.view;
    // the OLD per-step pipeline on the same conversation
    const pruned = pruneStaleReadsView(arch);
    const lc = await maybeCompact(pruned, legacyCache, 'm', 16384, ollama);
    legacyCache = lc.cache;
    const lv = hardCapOversizedMessages(lc.promptMessages);
    if (legacyPrev && !isExtension(legacyPrev, lv)) legacyBreaks++;
    legacyPrev = lv;
  }
  ok(breaks === events, `every prompt rewrite is explained by a deliberate event (breaks=${breaks}, events=${events})`);
  ok(events >= 1 && events <= 8, `a 24-step, ~48k-token session needs only a handful of cleanup events (got ${events})`);
  ok(legacyBreaks >= 10, `the previous per-step pipeline rewrote the prompt on ${legacyBreaks} of 23 steps`);
  ok(breaks * 2 <= legacyBreaks, `append-only breaks the prompt at most half as often (${breaks} vs ${legacyBreaks}) — each break costs a full re-read`);
}

async function testMaskEventIsBatchedPersistedAndIdempotent() {
  const o = { model: 'm', numCtx: 16384, ollama: fakeSummarizer() };
  const arch = readConversation(9, 6000); // ~18k tokens > 12288 high-water
  const r1 = await updatePromptView(arch, undefined, o);
  ok(r1.event?.kind === 'mask' && (r1.event.masked ?? 0) >= 3 && r1.event.tokensAfter < r1.event.tokensBefore, `crossing the high-water mark triggers ONE batched mask of many stale reads at once (masked ${r1.event?.masked}, ${r1.event?.tokensBefore}→${r1.event?.tokensAfter} tokens)`);
  ok(r1.event!.tokensAfter <= waterMarks(16384).lowTokens, 'and it cleans down to the LOW-water mark (real progress, not a nudge)');
  ok((r1.state.maskedIdx || []).length === r1.event!.masked, 'masked indices are recorded in the state');
  ok(o.ollama.calls === 0, 'masking alone needed no model call');
  const r2 = await updatePromptView(arch, r1.state, o);
  ok(!r2.event && snapshot(r2.view) === snapshot(r1.view), 'calling again with the returned state and the same archive is a no-op returning the identical view (masks persist)');
  const stubs = r1.view.filter((m) => m.content.startsWith('[Tool "read_file" result — superseded]'));
  ok(stubs.length === r1.event!.masked && stubs.every((m) => /read_file with \{"path":/.test(m.content)), 'each stub keeps the trace-visible prefix and tells the model exactly how to re-read');
  ok(r1.view[r1.view.length - 1].content === arch[arch.length - 1].content && r1.view[r1.view.length - 2].content === arch[arch.length - 2].content, 'the NEWEST TWO messages are never masked');
  // grows append-only again afterwards
  const next = [...arch, { role: 'assistant', content: readCall('g.txt') } as ChatMessage, { role: 'user', content: result('g.txt', 500) } as ChatMessage];
  const r3 = await updatePromptView(next, r2.state, o);
  ok(!r3.event && isExtension(r1.view, r3.view), 'after the event, the next step is append-only again (an exact extension, no event)');
}

async function testEscalationNeverThrashes() {
  // recent messages ALONE exceed the high-water mark: level 1 (keep last 6 reads) cannot fix it — escalation must.
  const o = { model: 'm', numCtx: 16384, ollama: fakeSummarizer() };
  let state: any; let events = 0; const arch: ChatMessage[] = [sys, task];
  for (let k = 0; k < 30; k++) {
    arch.push({ role: 'assistant', content: readCall(`f${k}.txt`) }, { role: 'user', content: result(`f${k}.txt`, 9000) }); // 3k tokens each: 6 recent reads = 18k > 12.3k
    const r = await updatePromptView(arch, state, o); state = r.state; if (r.event) events++;
    ok(r.estTokens <= waterMarks(16384).highTokens + 3200 || (failed++, false), `step ${k}: prompt stays within the window (est ${r.estTokens})`);
  }
  ok(events <= 15, `even with large recent reads it does not fire on every step (${events} events in 30 steps)`);
}

async function testCompactionEvent() {
  const o = { model: 'm', numCtx: 16384, ollama: fakeSummarizer() };
  const arch: ChatMessage[] = [sys, task];
  for (let i = 0; i < 30; i++) arch.push({ role: i % 2 ? 'user' : 'assistant', content: `chatter ${i} ` + 'z'.repeat(3000) });
  const before = snapshot(arch);
  const r = await updatePromptView(arch, undefined, o);
  ok(r.event?.kind === 'compact' && o.ollama.calls >= 1, `no reads to mask, prompt over the mark → the oldest turns are summarized (kind=${r.event?.kind}, model calls=${o.ollama.calls})`);
  ok(r.view[0] === sys && r.view[1] === task, 'the system prompt and the ORIGINAL USER REQUEST stay verbatim at the front (never summarized away)');
  ok(r.view[2].content.startsWith('[Earlier conversation summary') && r.view[2].content.includes('SUMMARY OF EARLIER WORK'), 'followed by the visible summary marker with a pointer to search_chat_history');
  ok(r.view[r.view.length - 1].content === arch[arch.length - 1].content && r.view[r.view.length - 2].content === arch[arch.length - 2].content, 'the newest messages are untouched');
  ok(r.view.length < arch.length && r.state.throughIndex > 0, 'state records how much was folded');
  ok(snapshot(arch) === before, 'the archival transcript is not mutated');
  ok(r.event!.tokensAfter <= waterMarks(16384).lowTokens, 'compaction escalates until the LOW-water mark is reached');
  const more = [...arch, { role: 'assistant', content: 'next step' } as ChatMessage, { role: 'user', content: 'a small tool result' } as ChatMessage];
  const calls = o.ollama.calls;
  const r2 = await updatePromptView(more, r.state, o);
  ok(!r2.event && o.ollama.calls === calls && isExtension(r.view, r2.view), 'after compaction, the next step is append-only again: no event, no model call, exact extension');
  // failing summarizer never throws
  const broken: any = { chat: async () => { throw new Error('model down'); } };
  let threw = false; let rb: any;
  try { rb = await updatePromptView(arch, undefined, { model: 'm', numCtx: 16384, ollama: broken }); } catch { threw = true; }
  ok(!threw && rb.view.length === arch.length && rb.state.throughIndex === 0, 'a failing summarizer never throws; the view is simply left as it was');
}

async function testOldPersistedStateAndEdgeCases() {
  const arch = readConversation(4, 200);
  const legacyState: any = { throughIndex: 4, summary: 'an old summary from before 0.15.0' };
  const r = await updatePromptView(arch, legacyState, { model: 'm', numCtx: 32768, ollama: fakeSummarizer() });
  ok(r.view.some((m) => m.content.includes('an old summary from before 0.15.0')) && Array.isArray(r.state.maskedIdx), 'a compaction cache saved by an earlier version (no maskedIdx/cpt) is understood');
  const empty = await updatePromptView([], undefined, { model: 'm', numCtx: 8192, ollama: fakeSummarizer() });
  ok(empty.view.length === 0 && !empty.event, 'an empty transcript is fine');
  const noSystem = await updatePromptView([task, { role: 'assistant', content: 'hi' }], undefined, { model: 'm', numCtx: 8192, ollama: fakeSummarizer() });
  ok(noSystem.view.length === 2, 'a transcript without a system message (sub-agents) is fine');
  const huge = readConversation(2, 500_000);
  const rh = await updatePromptView(huge, undefined, { model: 'm', numCtx: 32768, ollama: fakeSummarizer() });
  ok(rh.view.every((m, i) => i === 0 || m.content.length <= singleMessageCapChars(32768, 25) + 400), 'a single enormous tool result is capped for the model, including the newest one');
}

// ----------------------------------------- through the REAL agent loop -----------------------------------------
function ws(files: Record<string, string>): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pv-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(tmp, f), c);
  return vscode.Uri.file(tmp);
}
function depsFor(root: vscode.Uri, ollama: any, trace: TraceWriter) {
  const l = new TaskLedger();
  const ev: AgentEvent[] = [];
  return {
    ollama, pendingEdits: new PendingEditManager(root), approvalBroker: new ApprovalBroker((e: AgentEvent) => ev.push(e), () => [], () => false), hooks: new HookRunner(root),
    codebaseSearch: async () => [], rememberFact: async () => ({ added: false }), chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] }, mcpTools: [],
    taskLedger: { addTasks: (t: any[]) => t.map((x) => l.add(typeof x === 'string' ? x : x.description).id), updateTask: () => true, list: () => l.list() },
    trace, workspaceRoot: root, workspaceName: 't',
  } as any;
}

async function runLoop(appendOnly: boolean, nReads: number, chars: number, numCtx = 32768) {
  vs.__setConfig({ 'forge.context.appendOnly': appendOnly, 'forge.requirements.enabled': false });
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < nReads; i++) files[`f${i}.txt`] = 'abcdefghij\n'.repeat(Math.ceil(chars / 11));
    const root = ws(files);
    const prompts: ChatMessage[][] = [];
    let step = 0;
    const replies = Array.from({ length: nReads }, (_, i) => readCall(`f${i}.txt`)).concat(['All done.']);
    const fake: any = {
      chat: async (o: any) => {
        if (String(o.messages[0]?.content).startsWith('You compress coding-agent transcripts')) return 'SUMMARY OF EARLIER WORK';
        prompts.push(o.messages.map((m: any) => ({ role: m.role, content: m.content })));
        const total = o.messages.reduce((n: number, m: any) => n + m.content.length, 0);
        o.onMetrics?.({ model: 'f', promptTokens: Math.round(total / 3), promptTotalTokens: Math.round(total / 3), cachedTokens: 0, evalTokens: 5, tokensPerSecond: 20 });
        return replies[Math.min(step++, replies.length - 1)];
      },
    };
    const file = tracePathFor(root.fsPath, 'pv' + appendOnly);
    const writer = new TraceWriter(file, 'pv');
    await runAgentTurn([], 'read all the files', depsFor(root, fake, writer), () => {}, new vscode.CancellationTokenSource().token, 'fake', { mode: 'auto', numCtx });
    await writer.flush();
    const trace = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    let breaks = 0;
    for (let i = 1; i < prompts.length; i++) if (!isExtension(prompts[i - 1], prompts[i])) breaks++;
    return { prompts, breaks, trace, events: trace.filter((t: any) => t.viewEvent).length };
  } finally {
    vs.__resetConfig();
  }
}

async function testRealLoop() {
  // Realistic sizing: a 32k window and ~2k-token reads (a cleanup then buys ~5 steps of headroom: the gap between the 45% and 75% marks).
  const a = await runLoop(true, 30, 6000);
  ok(a.prompts.length === 31, `the loop made 31 model calls (30 reads + the answer), got ${a.prompts.length}`);
  ok(a.breaks === a.events, `REAL LOOP, append-only: every prompt that is not an extension of the previous one is explained by a recorded cleanup event (breaks=${a.breaks}, events=${a.events})`);
  ok(a.events >= 1 && a.events <= 8, `…and only a handful of cleanup events over 30 large reads (got ${a.events})`);
  ok(a.prompts.every((p) => p[0].role === 'system' && p[0].content === a.prompts[0][0].content), 'the system prompt is byte-identical on every step (frozen prefix)');
  ok(a.trace.some((t: any) => t.viewEvent === 'mask' || t.viewEvent === 'compact'), 'events appear in the trace (viewEvent) so a run can be audited');
  const l = await runLoop(false, 30, 6000);
  ok(l.breaks >= 15, `REAL LOOP, legacy per-step pruning (forge.context.appendOnly=false): the prompt is rewritten on ${l.breaks} of 30 steps`);
  ok(a.breaks * 2 <= l.breaks, `append-only rewrites the prompt at most half as often as legacy (${a.breaks} vs ${l.breaks}) — measured cost of each rewrite on MLX is a full prompt re-read`);
  const tight = await runLoop(true, 24, 6000, 16384);
  ok(tight.breaks === tight.events && tight.breaks < (await runLoop(false, 24, 6000, 16384)).breaks, `even in a deliberately tight 16k window with huge reads, rewrites stay explained by events and fewer than legacy (append-only ${tight.breaks})`);
  const small = await runLoop(true, 6, 400);
  ok(small.breaks === 0 && small.events === 0, 'a small session is a pure append-only chain: zero rewrites, zero events');
}

async function main() {
  testHelpers();
  testStaleRules();
  await testPrefixStabilityUnderHighWater();
  await testFewEventsVersusLegacy();
  await testMaskEventIsBatchedPersistedAndIdempotent();
  await testEscalationNeverThrashes();
  await testCompactionEvent();
  await testOldPersistedStateAndEdgeCases();
  await testRealLoop();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 prompt-view tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 prompt-view tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_promptview.ts:', err); process.exit(1); });
