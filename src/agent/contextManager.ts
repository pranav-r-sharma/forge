import { ChatMessage } from '../ollama/types';
import { LlmProvider } from '../llm/provider';
import { parseToolCall } from './toolProtocol';

/**
 * Keeps the *prompt actually sent to Ollama* bounded on long agent turns,
 * without ever discarding what's persisted to `.forge/chat/`.
 *
 * This is the important design decision here, and it's a deliberate
 * departure from the original local hack this ported from (see
 * CHANGELOG.md 0.3.0): that version pruned/compacted the SAME array that
 * got saved as the session's permanent history, so shrinking the prompt
 * also permanently erased that detail from the transcript on disk — exactly
 * the "don't lose my information" problem the user flagged. Here,
 * `ChatSession.modelHistory` (what's persisted and what powers search /
 * checkpoints / crash-recovery) is never touched by this module. Only a
 * transient "prompt view" built fresh before each model call is pruned —
 * the full conversation is always still sitting in the session file if you
 * scroll up, search it (see chat search), or need to hand it to a smarter
 * process later.
 */

const KEEP_RECENT_TOOL_RESULTS = 6;
const KEEP_RECENT_MESSAGES = 12;
const MIN_COMPACT_CHAR_THRESHOLD = 40_000;
const MAX_COMPACT_CHAR_THRESHOLD = 600_000;
const MAX_SINGLE_MESSAGE_CHARS = 20_000;

export interface CompactionCache {
  /** Index into the archival array (after the system prompt) already folded into `summary`. */
  throughIndex: number;
  summary: string;
}

/** Char budget for the live prompt, derived from the configured context window (rough 4-chars/token heuristic), kept well under half of it so there's always headroom for output + the next tool result. */
export function compactionThreshold(numCtx: number): number {
  return clamp((numCtx || 8192) * 4 * 0.5, MIN_COMPACT_CHAR_THRESHOLD, MAX_COMPACT_CHAR_THRESHOLD);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Returns a NEW array with stale `read_file` results replaced by short
 * placeholders — never mutates `messages`. A read is stale if: the same
 * file was written later in the transcript, a newer read of the same file
 * exists, or it's simply older than the last `KEEP_RECENT_TOOL_RESULTS`
 * tool results.
 */
export function pruneStaleReadsView(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.map((m) => ({ ...m }));

  const writeIdxByPath = new Map<string, number[]>();
  const reads: { path: string; resultIdx: number }[] = [];

  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role !== 'assistant') continue;
    const call = parseToolCall(m.content);
    if (!call) continue;
    const path: string | undefined = call.args?.path ?? call.args?.file;
    if (!path) continue;
    if (call.tool === 'read_file' && out[i + 1]?.role === 'user') {
      reads.push({ path, resultIdx: i + 1 });
    } else if (call.tool === 'write_file') {
      const list = writeIdxByPath.get(path) || [];
      list.push(i);
      writeIdxByPath.set(path, list);
    }
  }

  const latestReadIdxByPath = new Map<string, number>();
  for (const r of reads) latestReadIdxByPath.set(r.path, r.resultIdx); // last write in iteration order wins = latest read

  const toolResultIndices: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === 'user' && /^\[Tool "/.test(out[i].content)) toolResultIndices.push(i);
  }
  const protectedResultIdx = new Set(toolResultIndices.slice(-KEEP_RECENT_TOOL_RESULTS));

  for (const r of reads) {
    const laterWrite = (writeIdxByPath.get(r.path) || []).some((wi) => wi > r.resultIdx);
    const superseded = latestReadIdxByPath.get(r.path) !== r.resultIdx;
    const old = !protectedResultIdx.has(r.resultIdx);
    if (!laterWrite && !superseded && !old) continue;
    const reason = laterWrite
      ? 'the file was written after this read'
      : superseded
        ? 'a newer read of this file exists later in the conversation'
        : 'older tool result, pruned to save context';
    out[r.resultIdx] = { ...out[r.resultIdx], content: `[Tool "read_file" result — superseded]\n${r.path}: ${reason}.` };
  }

  return out;
}

/**
 * Once the (post-pruning) prompt view exceeds the char budget, folds
 * everything except the system prompt and the last `KEEP_RECENT_MESSAGES`
 * into a single model-generated summary message. Caches the summary keyed
 * by how much of the archival transcript it covers, so a long turn doesn't
 * re-summarize from scratch on every iteration — only once genuinely new
 * old-enough content accumulates past what's already cached.
 *
 * Never mutates `archival` or throws on failure — if the summarization call
 * itself fails (network hiccup, cancellation), this silently falls back to
 * the uncompacted view rather than breaking the user's turn.
 */
export async function maybeCompact(
  archival: ChatMessage[],
  cache: CompactionCache | undefined,
  model: string,
  numCtx: number,
  ollama: LlmProvider,
  signal?: AbortSignal
): Promise<{ promptMessages: ChatMessage[]; cache: CompactionCache | undefined }> {
  const threshold = compactionThreshold(numCtx);
  const totalChars = archival.reduce((n, m) => n + m.content.length, 0);
  if (totalChars <= threshold) return { promptMessages: archival, cache };

  const hasSystem = archival.length > 0 && archival[0].role === 'system';
  const bodyStart = hasSystem ? 1 : 0;
  const tailStart = Math.max(bodyStart, archival.length - KEEP_RECENT_MESSAGES);

  if (tailStart <= bodyStart) return { promptMessages: archival, cache }; // nothing old enough to safely fold away

  if (cache && cache.throughIndex >= tailStart) {
    return { promptMessages: buildCompactedView(archival, hasSystem, bodyStart, cache), cache };
  }

  const toSummarize = archival.slice(bodyStart, tailStart);
  const transcriptText = toSummarize
    .map((m) => `${m.role.toUpperCase()}: ${m.content.length > 2000 ? m.content.slice(0, 2000) + '…(truncated)' : m.content}`)
    .join('\n\n');

  let summaryText: string;
  try {
    summaryText = await ollama.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You compress coding-agent transcripts. Summarize into a short, dense list: what was explored, which files were read/edited and why, key facts or decisions made, and the current state of the task. Omit verbatim file contents, line numbers, and tool call syntax. Be concise — under 400 words.',
        },
        { role: 'user', content: transcriptText },
      ],
      temperature: 0.1,
      signal,
    });
  } catch {
    return { promptMessages: archival, cache };
  }

  const newCache: CompactionCache = { throughIndex: tailStart, summary: summaryText.trim() };
  if (!newCache.summary) return { promptMessages: archival, cache };
  return { promptMessages: buildCompactedView(archival, hasSystem, bodyStart, newCache), cache: newCache };
}

function buildCompactedView(archival: ChatMessage[], hasSystem: boolean, bodyStart: number, cache: CompactionCache): ChatMessage[] {
  return [
    ...(hasSystem ? [archival[0]] : []),
    {
      role: 'user',
      content: `[Earlier conversation summary — ${cache.throughIndex - bodyStart} message(s) compacted to save context. Nothing was lost: the full original messages are still in this session's saved history. If you need an exact detail this summary omitted — exact code, an exact error message, a specific earlier decision — call search_chat_history rather than guessing.]\n${cache.summary}`,
    },
    ...archival.slice(cache.throughIndex),
  ];
}

/**
 * Last line of defense: even after pruning + compaction, one abnormally
 * large message (a huge command output, a runaway tool result) could still
 * blow past the budget. Truncates any single message over
 * `MAX_SINGLE_MESSAGE_CHARS`, except the last two (never cut what the model
 * just said / just saw — that's usually exactly what it needs to react to).
 */
export function hardCapOversizedMessages(messages: ChatMessage[]): ChatMessage[] {
  const protectFromEnd = 2;
  return messages.map((m, i) => {
    if (i >= messages.length - protectFromEnd) return m;
    if (m.content.length <= MAX_SINGLE_MESSAGE_CHARS) return m;
    const headLen = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.7);
    const tailLen = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.2);
    const head = m.content.slice(0, headLen);
    const tail = m.content.slice(-tailLen);
    const trimmed = m.content.length - head.length - tail.length;
    return { ...m, content: `${head}\n... (${trimmed} chars trimmed to save context) ...\n${tail}` };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Append-only prompt view (v0.15.0 plan §2.1 / §2.1e).
//
// MEASURED (Ornith on the MLX server): a prompt that only GROWS is ~93-94% served from the runtime's prompt cache (~9x faster per step);
// replacing ONE old message with a stub drops the hit to ~1% and forces a full re-read. The per-step pruning above does exactly that, so this
// path never rewrites anything already sent. It changes the prompt only in two deliberate, BATCHED events, each costing one cache miss:
//   1. "mask": once the estimated prompt crosses the HIGH-water mark, replace every stale read_file result with a small stub, all at once;
//   2. "compact": if that is not enough (still above the LOW-water mark), fold the oldest turns into one model-written summary (the original
//      request stays verbatim).
// Between events the view is a pure function of (archival, state) with no dependence on position, so consecutive prompts are byte-identical up to
// the newest message. The archival/persisted transcript is never touched.
// ---------------------------------------------------------------------------------------------------------------------------------------

export const DEFAULT_CHARS_PER_TOKEN = 3.0;
/** Fixed (not learned) so the per-message cap never shifts between steps and rewrites a message that was already sent. */
const CAP_CHARS_PER_TOKEN = 3.0;

export interface PromptViewState extends CompactionCache {
  /** Indices (into the archival array) of read_file results already replaced by stubs — persisted so they stay stubs forever (stable prefix). */
  maskedIdx?: number[];
  /** Learned characters-per-token for this model/content (EMA of real token counts) — used only to ESTIMATE prompt size for the water marks. */
  cpt?: number;
}

export interface WaterMarks {
  highTokens: number;
  lowTokens: number;
}

export function waterMarks(numCtx: number, highPct = 75, lowPct = 45): WaterMarks {
  const n = numCtx > 0 ? numCtx : 8192;
  const hp = clamp(highPct, 30, 95);
  const lp = clamp(Math.min(lowPct, hp - 10), 10, hp - 5);
  return { highTokens: Math.floor((n * hp) / 100), lowTokens: Math.floor((n * lp) / 100) };
}

export function estimateTokens(chars: number, cpt: number): number {
  return Math.ceil(chars / (cpt > 0 ? cpt : DEFAULT_CHARS_PER_TOKEN));
}

/** EMA of measured chars/token. Ignores tiny prompts and implausible values so one odd reading can't swing the compaction trigger. */
export function updateCharsPerToken(prev: number | undefined, chars: number, tokens: number | undefined): number {
  const base = prev && prev > 0 ? prev : DEFAULT_CHARS_PER_TOKEN;
  if (!tokens || tokens < 200 || chars < 600) return base;
  const observed = chars / tokens;
  if (!Number.isFinite(observed) || observed < 1.2 || observed > 8) return base;
  return clamp(base * 0.7 + observed * 0.3, 1.5, 6);
}

/** Largest single message (chars) the model will see. Position-independent and independent of the learned chars/token, so it never changes for a message already sent. */
export function singleMessageCapChars(numCtx: number, sharePct = 25): number {
  const n = numCtx > 0 ? numCtx : 8192;
  const pct = clamp(sharePct, 5, 80) / 100;
  const upper = Math.max(120_000, Math.floor(n * CAP_CHARS_PER_TOKEN * 0.8));
  return clamp(Math.floor(n * pct * CAP_CHARS_PER_TOKEN), 12_000, upper);
}

/** Truncates any oversized non-system message the same way regardless of where it sits (unlike hardCapOversizedMessages, which exempts the newest two and so rewrites them later). */
export function capOversizedStable(messages: ChatMessage[], capChars: number): ChatMessage[] {
  return messages.map((m, i) => {
    if (i === 0 && m.role === 'system') return m;
    if (m.content.length <= capChars) return m;
    const headLen = Math.floor(capChars * 0.7);
    const tailLen = Math.floor(capChars * 0.2);
    const trimmed = m.content.length - headLen - tailLen;
    return { ...m, content: `${m.content.slice(0, headLen)}\n... (${trimmed} chars trimmed to fit the context window — re-run the tool with a narrower request, e.g. read_file with start_line/end_line) ...\n${m.content.slice(-tailLen)}` };
  });
}

export interface StaleRead {
  idx: number;
  path: string;
  reason: string;
}

/** Same staleness rules as pruneStaleReadsView (written after, superseded by a newer read, or older than the last KEEP_RECENT_TOOL_RESULTS results) — but returns indices instead of rewriting, so callers can decide WHEN to apply them. */
export function staleReadIndices(messages: ChatMessage[], keepRecent: number = KEEP_RECENT_TOOL_RESULTS): StaleRead[] {
  const writeIdxByPath = new Map<string, number[]>();
  const reads: { path: string; resultIdx: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const call = parseToolCall(m.content);
    if (!call) continue;
    const path: string | undefined = call.args?.path ?? call.args?.file;
    if (!path) continue;
    if (call.tool === 'read_file' && messages[i + 1]?.role === 'user') reads.push({ path, resultIdx: i + 1 });
    else if (call.tool === 'write_file') {
      const list = writeIdxByPath.get(path) || [];
      list.push(i);
      writeIdxByPath.set(path, list);
    }
  }
  const latestReadIdxByPath = new Map<string, number>();
  for (const r of reads) latestReadIdxByPath.set(r.path, r.resultIdx);
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user' && /^\[Tool "/.test(messages[i].content)) toolResultIndices.push(i);
  const protectedIdx = new Set(keepRecent > 0 ? toolResultIndices.slice(-keepRecent) : []);
  const out: StaleRead[] = [];
  for (const r of reads) {
    if (!/^\[Tool "read_file" result\]/.test(messages[r.resultIdx].content)) continue; // already a stub, or an error result
    const laterWrite = (writeIdxByPath.get(r.path) || []).some((wi) => wi > r.resultIdx);
    const superseded = latestReadIdxByPath.get(r.path) !== r.resultIdx;
    const old = !protectedIdx.has(r.resultIdx);
    if (!laterWrite && !superseded && !old) continue;
    out.push({ idx: r.resultIdx, path: r.path, reason: laterWrite ? 'the file was written after this read' : superseded ? 'a newer read of this file exists later in the conversation' : 'older tool result, dropped to save context' });
  }
  return out;
}

/** The stub keeps the `[Tool "read_file" result — superseded]` prefix (the trace counts it) and says how to get the content back. */
export function readStub(path: string, reason: string): string {
  return `[Tool "read_file" result — superseded]\n${path}: ${reason}. Its earlier content was removed from this prompt to save context; call read_file with {"path":"${path}","start_line":…,"end_line":…} if you need a specific part again.`;
}

export function applyMasks(messages: ChatMessage[], masked: readonly number[], reasons?: Map<number, StaleRead>): ChatMessage[] {
  if (!masked.length) return messages;
  const set = new Set(masked);
  return messages.map((m, i) => {
    if (!set.has(i)) return m;
    const info = reasons?.get(i);
    const path = info?.path ?? pathOfReadAt(messages, i) ?? 'a file';
    return { ...m, content: readStub(path, info?.reason ?? 'older tool result, dropped to save context') };
  });
}

function pathOfReadAt(messages: ChatMessage[], resultIdx: number): string | undefined {
  const call = messages[resultIdx - 1] ? parseToolCall(messages[resultIdx - 1].content) : null;
  return call?.args?.path ?? call?.args?.file;
}

function normalizeState(s: CompactionCache | PromptViewState | undefined): Required<Pick<PromptViewState, 'throughIndex' | 'summary' | 'maskedIdx'>> & { cpt?: number } {
  const v = (s || {}) as PromptViewState;
  return { throughIndex: v.throughIndex || 0, summary: v.summary || '', maskedIdx: Array.isArray(v.maskedIdx) ? v.maskedIdx : [], cpt: v.cpt };
}

/** Compaction summary substituted for archival[bodyStart..throughIndex), with the ORIGINAL first user message kept verbatim in front of it. */
function buildPinnedCompactedView(archival: ChatMessage[], throughIndex: number, summary: string): ChatMessage[] {
  const hasSystem = archival.length > 0 && archival[0].role === 'system';
  const bodyStart = hasSystem ? 1 : 0;
  const pinned = archival[bodyStart]?.role === 'user' && throughIndex > bodyStart + 1 ? [archival[bodyStart]] : [];
  const summarized = throughIndex - bodyStart - pinned.length;
  return [
    ...(hasSystem ? [archival[0]] : []),
    ...pinned,
    {
      role: 'user',
      content: `[Earlier conversation summary — ${summarized} message(s) compacted to save context. Nothing was lost: the full original messages are still in this session's saved history. If you need an exact detail this summary omitted — exact code, an exact error message, a specific earlier decision — call search_chat_history rather than guessing.]\n${summary}`,
    },
    ...archival.slice(throughIndex),
  ];
}

export interface PromptViewOptions {
  model: string;
  numCtx: number;
  ollama: LlmProvider;
  signal?: AbortSignal;
  highWaterPct?: number;
  lowWaterPct?: number;
  singleMessageSharePct?: number;
}

export interface PromptViewResult {
  view: ChatMessage[];
  state: PromptViewState;
  /** Set only on the steps where the prompt was deliberately rewritten (each costs one cache miss). */
  event?: { kind: 'mask' | 'compact'; tokensBefore: number; tokensAfter: number; masked?: number };
  estTokens: number;
}

const SUMMARY_SYSTEM =
  'You compress coding-agent transcripts. Summarize into a short, dense list: what was explored, which files were read/edited and why, key facts or decisions made, and the current state of the task. Omit verbatim file contents, line numbers, and tool call syntax. Be concise — under 400 words.';

/**
 * Builds the prompt view for this step. Pure function of (archival, state) unless a water mark is crossed, in which case it performs exactly one
 * batched event and returns the updated state for the caller to keep. Never mutates `archival`; never throws (a failed summary falls back to
 * whatever masking achieved).
 */
export async function updatePromptView(archival: ChatMessage[], stateIn: CompactionCache | PromptViewState | undefined, o: PromptViewOptions): Promise<PromptViewResult> {
  const st = normalizeState(stateIn);
  const cpt = st.cpt && st.cpt > 0 ? st.cpt : DEFAULT_CHARS_PER_TOKEN;
  const capChars = singleMessageCapChars(o.numCtx, o.singleMessageSharePct ?? 25);
  const { highTokens, lowTokens } = waterMarks(o.numCtx, o.highWaterPct, o.lowWaterPct);
  const stateOut = (masked: number[], throughIndex: number, summary: string): PromptViewState => ({ throughIndex, summary, maskedIdx: masked, cpt: st.cpt });
  const build = (masked: number[], throughIndex: number, summary: string): ChatMessage[] => {
    const base = applyMasks(archival, masked);
    return capOversizedStable(throughIndex > 0 && summary ? buildPinnedCompactedView(base, throughIndex, summary) : base, capChars);
  };
  const size = (v: ChatMessage[]) => estimateTokens(v.reduce((n, m) => n + m.content.length, 0), cpt);

  let view = build(st.maskedIdx, st.throughIndex, st.summary);
  let tokens = size(view);
  if (tokens <= highTokens) return { view, state: stateOut(st.maskedIdx, st.throughIndex, st.summary), estTokens: tokens };

  // ---- batched cleanup, escalating only as far as needed to reach the LOW-water mark ----
  // Level 1 protects the last 6 tool results / 12 messages (the old behaviour); later levels protect fewer, so a cleanup always makes real
  // progress even when the recent messages alone are large (otherwise it would fire on every step). The NEWEST TWO messages are never touched —
  // the model has not yet reacted to the newest tool result.
  const hasSystem = archival.length > 0 && archival[0].role === 'system';
  const bodyStart = hasSystem ? 1 : 0;
  const untouchable = archival.length - 2;
  const maskLevels = [KEEP_RECENT_TOOL_RESULTS, 2, 0];
  const compactKeeps = [KEEP_RECENT_MESSAGES, 6, 3];
  const masked = [...st.maskedIdx];
  const reasons = new Map<number, StaleRead>();
  let maskedNow = 0;
  let maskedBase = applyMasks(archival, masked);
  const buildMasked = (throughIndex: number, summary: string) => capOversizedStable(throughIndex > 0 && summary ? buildPinnedCompactedView(maskedBase, throughIndex, summary) : maskedBase, capChars);
  let after = tokens;
  for (const keep of maskLevels) {
    const fresh = staleReadIndices(archival, keep).filter((r) => r.idx < untouchable && !masked.includes(r.idx));
    if (fresh.length) {
      for (const f of fresh) { masked.push(f.idx); reasons.set(f.idx, f); }
      maskedNow += fresh.length;
      masked.sort((x, y) => x - y);
      maskedBase = applyMasks(archival, masked, reasons);
    }
    view = buildMasked(st.throughIndex, st.summary);
    after = size(view);
    if (after <= lowTokens) return { view, state: stateOut(masked, st.throughIndex, st.summary), event: maskedNow ? { kind: 'mask', tokensBefore: tokens, tokensAfter: after, masked: maskedNow } : undefined, estTokens: after };
  }
  const maskedOnly: PromptViewResult = { view, state: stateOut(masked, st.throughIndex, st.summary), event: maskedNow ? { kind: 'mask', tokensBefore: tokens, tokensAfter: after, masked: maskedNow } : undefined, estTokens: after };

  // still above the low-water mark: fold the oldest turns into a summary (one model call), protecting fewer recent messages each round
  let best = maskedOnly;
  let throughSoFar = st.throughIndex;
  let summarySoFar = st.summary;
  for (const keepMsgs of compactKeeps) {
    const tailStart = Math.min(Math.max(bodyStart, archival.length - keepMsgs), untouchable);
    if (tailStart <= Math.max(bodyStart + 1, throughSoFar)) continue; // nothing older left to fold at this level
    const transcript = maskedBase
      .slice(bodyStart + 1, tailStart) // the pinned first user message stays verbatim, so it is not re-summarized
      .map((m) => `${m.role.toUpperCase()}: ${m.content.length > 2000 ? m.content.slice(0, 2000) + '…(truncated)' : m.content}`)
      .join('\n\n');
    let summary = '';
    try {
      summary = (await o.ollama.chat({ model: o.model, messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: transcript }], temperature: 0.1, signal: o.signal, thinking: false })).trim();
    } catch {
      /* keep the masked view */
    }
    if (!summary) break;
    throughSoFar = tailStart;
    summarySoFar = summary;
    view = buildMasked(tailStart, summary);
    after = size(view);
    best = { view, state: stateOut(masked, tailStart, summary), event: { kind: 'compact', tokensBefore: tokens, tokensAfter: after, masked: maskedNow }, estTokens: after };
    if (after <= lowTokens) break;
  }
  return best;
}
