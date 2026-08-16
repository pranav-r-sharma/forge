import { ChatMessage } from '../ollama/types';
import { OllamaClient } from '../ollama/client';
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
  ollama: OllamaClient,
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
      content: `[Earlier conversation summary — ${cache.throughIndex - bodyStart} message(s) compacted to save context]\n${cache.summary}`,
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
