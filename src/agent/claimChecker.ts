import { ChatMessage } from '../ollama/types';

/**
 * Mitigates a specific, reported failure mode: the model's final answer
 * claims it created/updated a file when no `write_file` call for that path
 * actually happened this turn — a text-generation hallucination, since
 * nothing here is a "memory" the model can be wrong about; the tool
 * protocol is the only way anything actually happens (see systemPrompt.ts).
 * It just... says it did the thing instead of calling the tool that does it.
 *
 * `extractClaimedPaths` finds backtick-quoted file paths after a
 * change-verb ("created `foo.ts`", "updated `src/bar.py`"). Kept
 * intentionally narrow (verb + backtick-quoted path with an extension) to
 * keep false positives low — this is a soft nudge back into the loop, not a
 * hard block, so a few misses are fine but a false positive that makes the
 * model loop on a claim it didn't actually make would be worse.
 */
const CLAIM_RE = /\b(?:created|added|wrote|updated|modified|edited|generated|saved|deleted|removed)\b[^.\n`]{0,60}?`([^`\s]+\.[A-Za-z0-9]{1,10})`/gi;

export function extractClaimedPaths(finalText: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  CLAIM_RE.lastIndex = 0;
  while ((m = CLAIM_RE.exec(finalText))) {
    found.add(m[1]);
  }
  return [...found];
}

/** True if `path` appears anywhere as the subject of a write_file tool call/result in the transcript so far (this turn or any earlier one). Approximate by design — a substring scan over the raw message text, not a structured index — but effective and avoids false positives across turns. */
export function wasEverWritten(path: string, messages: ChatMessage[]): boolean {
  const needle = path.toLowerCase();
  for (const m of messages) {
    const c = m.content.toLowerCase();
    if (!c.includes('write_file') && !c.includes('"tool "write_file" result"'.toLowerCase()) && !c.includes('[tool "write_file" result]'.toLowerCase())) {
      continue;
    }
    if (c.includes(needle)) return true;
  }
  return false;
}

/** Paths the final answer claims were changed but that never actually went through write_file, per the transcript. Empty array = nothing suspicious. */
export function findUnverifiedClaims(finalText: string, messages: ChatMessage[]): string[] {
  const claimed = extractClaimedPaths(finalText);
  return claimed.filter((p) => !wasEverWritten(p, messages));
}
