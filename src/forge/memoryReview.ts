import { OllamaClient } from '../ollama/client';

const MAX_FACTS_PER_REVIEW = 5;
const MAX_TRANSCRIPT_CHARS = 6000;

/**
 * The automatic half of the memory system: `remember` (memoryTools.ts) only
 * ever fires when the model itself thinks to call it mid-conversation, which
 * is a real gap — plenty of durable facts come up in passing and never get
 * flagged. This runs periodically (see ChatSession — every few turns, not
 * every turn, and always fire-and-forget so it can never slow a turn down)
 * as a small, focused review pass: "did anything durable happen in this
 * stretch of conversation that isn't already saved."
 *
 * Deliberately narrow and cheap: one short call, capped output, and
 * everything it proposes still goes through MemoryStore.addFact()'s
 * case-insensitive de-dupe — so even an over-eager review pass can't spam
 * `.forge/memory.md`, it can only add each fact once.
 */
export async function reviewForMemoryFacts(
  transcriptExcerpt: string,
  ollama: OllamaClient,
  model: string,
  existingFacts: string[]
): Promise<string[]> {
  const excerpt = transcriptExcerpt.length > MAX_TRANSCRIPT_CHARS ? transcriptExcerpt.slice(-MAX_TRANSCRIPT_CHARS) : transcriptExcerpt;
  if (!excerpt.trim()) return [];

  const existingBlock = existingFacts.length > 0 ? `\n\nAlready remembered (do not repeat these):\n${existingFacts.map((f) => `- ${f}`).join('\n')}` : '';

  let raw: string;
  try {
    raw = await ollama.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            `You review a coding-agent conversation excerpt for durable facts worth remembering long-term for this project: conventions ("this repo uses pnpm"), explicit user preferences, decisions and their reasons, where things live. NOT routine progress ("read file X", "ran the tests"), NOT anything already obvious from generic best practice, NOT anything already in the "already remembered" list below.\n\n` +
            `Respond with ONLY a JSON array of short strings, each one fact, in this exact shape and nothing else: ["fact one", "fact two"]. If there is nothing new and durable worth remembering, respond with exactly: []. Never invent facts that aren't actually supported by the excerpt.`,
        },
        { role: 'user', content: `${excerpt}${existingBlock}` },
      ],
      temperature: 0.1,
    });
  } catch {
    return [];
  }

  return parseFactsArray(raw).slice(0, MAX_FACTS_PER_REVIEW);
}

/** Defensive parsing: models don't always respect "JSON only" — pulls the first `[...]` block out of whatever text came back and tolerates it not being valid JSON at all. */
export function parseFactsArray(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map((f) => f.trim());
  } catch {
    return [];
  }
}
