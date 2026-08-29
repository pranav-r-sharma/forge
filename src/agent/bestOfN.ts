import { ChatMessage } from '../ollama/types';
import { OllamaClient } from '../ollama/client';
import { ToolCall } from './types';
import { parseToolCall } from './toolProtocol';
import { detectBalanceRegression } from '../tools/fileTools';
import { logger } from '../util/logger';

/** Only worth the extra model calls for a genuinely large rewrite — see agentLoop.ts's wiring. A small edit's blast radius is small enough that one generation is already fine. */
export const MIN_LINES_FOR_BEST_OF_N = 40;

export interface RewriteCandidate {
  fullText: string;
  call: ToolCall | null;
}

/**
 * Self-consistency / best-of-N for the single riskiest step in the whole
 * agent loop: a full-file rewrite of an EXISTING file (`write_file` with
 * `{"content": ...}`, not `{"search","replace"}` — a full rewrite is where a
 * single bad generation can silently discard content the targeted-edit path
 * would never have touched). `forge.bestOfN.enabled` (off by default: this
 * is N model calls instead of 1, a real latency/compute cost, so it's opt-in
 * and scoped to exactly this one high-blast-radius case rather than applied
 * to every step).
 *
 * Mechanism: `firstCandidate` is the completion the main loop already
 * generated for this iteration; this samples `samples - 1` MORE completions
 * from the exact same prompt (so they're genuinely alternative continuations
 * of the same conversation state, not re-answers to a different question),
 * then scores every candidate that itself proposes a `write_file` full
 * rewrite of the SAME path with a cheap, dependency-free heuristic:
 *
 * - Reject outright (score -Infinity) any candidate that ISN'T a same-path
 *   full-rewrite write_file call, or whose content is suspiciously short
 *   relative to the file it's replacing (a common local-model failure mode:
 *   silently truncating/summarizing instead of reproducing the whole file).
 * - Penalize a candidate whose resulting file would introduce a bracket-
 *   balance regression that didn't exist before (see fileTools.ts's
 *   detectBalanceRegression — same crude, string/comment-unaware but cheap
 *   check already used for the single-generation advisory).
 * - Prefer, among what's left, the candidate closest in length to the
 *   original (a rough proxy for "actually reproduced the file rather than
 *   dropping unrelated parts of it").
 *
 * If every resampled candidate scores -Infinity (none produced a usable
 * rewrite), this falls back to `firstCandidate` unchanged — best-of-N can
 * only ever swap in a candidate that scored strictly better, never block the
 * turn or force a retry loop.
 */
export async function sampleBestOfNForRewrite(opts: {
  ollama: OllamaClient;
  promptView: ChatMessage[];
  model: string;
  temperature: number;
  numCtx?: number;
  signal?: AbortSignal;
  samples: number;
  firstCandidate: RewriteCandidate;
  existingFileText: string;
  expectedPath: string;
}): Promise<RewriteCandidate> {
  const extraCount = Math.max(0, Math.min(opts.samples, 5) - 1);
  const candidates: RewriteCandidate[] = [opts.firstCandidate];

  for (let i = 0; i < extraCount; i++) {
    try {
      const fullText = await opts.ollama.chat({
        model: opts.model,
        messages: opts.promptView,
        temperature: Math.max(opts.temperature, 0.5), // a little more sampling diversity than the turn's own temperature — identical-every-time samples would defeat the point
        numCtx: opts.numCtx,
        signal: opts.signal,
      });
      candidates.push({ fullText, call: parseToolCall(fullText) });
    } catch (err) {
      logger.warn('best-of-N resample failed, continuing with fewer candidates', String(err));
    }
  }

  let best = opts.firstCandidate;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreRewriteCandidate(candidate, opts.existingFileText, opts.expectedPath);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function scoreRewriteCandidate(candidate: RewriteCandidate, existingFileText: string, expectedPath: string): number {
  const call = candidate.call;
  if (!call || call.tool !== 'write_file') return -Infinity;
  const path = call.args?.path ?? call.args?.file;
  if (path !== expectedPath) return -Infinity;
  const content = call.args?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return -Infinity;

  // Suspiciously truncated relative to what it's replacing — a common
  // failure mode is the model "summarizing" instead of reproducing the file.
  if (existingFileText.length > 200 && content.length < existingFileText.length * 0.3) return -Infinity;

  let score = 0;
  if (!detectBalanceRegression(existingFileText, content)) score += 1;
  const lengthRatio = content.length / Math.max(1, existingFileText.length);
  score += 1 - Math.min(1, Math.abs(1 - lengthRatio)); // closer to the original length scores higher, capped
  return score;
}
