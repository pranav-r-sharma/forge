import { ChatMessage } from '../ollama/types';
import { LlmProvider } from '../llm/provider';
import { logger } from '../util/logger';

const MAX_PLAN_CHARS = 1500;
const MAX_SNIPPET_CHARS = 600;

/**
 * Optional "separate planner/executor prompts" step (`forge.planFirst.enabled`,
 * off by default): one extra, no-tool-schema model call at the START of a
 * turn — pure reasoning, not constrained by the forge_action contract — that
 * produces a short plan, plus a couple of "few-shot"-style grounding
 * snippets pulled from the codebase via semantic search. The result is
 * prepended to this turn's own context (see systemPrompt.ts's
 * buildTurnContextPrefix() / agentLoop.ts's wiring), so every subsequent
 * tool-calling iteration in the main loop can see it.
 *
 * Why this is worth an extra call: a single prompt asking a small local
 * model to "plan AND act AND stay inside a strict JSON contract" all at once
 * asks more of it per token than two focused calls — one pure-reasoning pass
 * with no output-format constraint, followed by normal tool-calling turns
 * that can lean on that plan. This mirrors the reasoning that already
 * motivated Plan mode as a distinct mode; this is the same idea applied
 * *inside* a single Agent/Auto/Outcome turn rather than requiring a separate
 * mode switch.
 *
 * Best-effort by design: any failure (network hiccup, cancellation, an
 * unreachable model) returns undefined rather than throwing, so a broken
 * planning pass degrades to "no plan prefix this turn," never to a failed
 * turn — the same fire-and-forget-safety pattern contextManager.ts's
 * maybeCompact() already uses for its own extra model call.
 */
export async function generatePlanFirst(opts: {
  ollama: LlmProvider;
  model: string;
  userMessage: string;
  recentMessages: ChatMessage[];
  codebaseSearch?: (query: string, k: number) => Promise<{ path: string; snippet: string; score: number }[]>;
  signal?: AbortSignal;
  numCtx?: number;
}): Promise<string | undefined> {
  let groundingBlock = '';
  if (opts.codebaseSearch) {
    try {
      const hits = await opts.codebaseSearch(opts.userMessage, 3);
      if (hits.length > 0) {
        groundingBlock =
          '\n\nPotentially relevant existing code (from a codebase search — may or may not actually be relevant):\n' +
          hits.map((h) => `--- ${h.path} ---\n${h.snippet.slice(0, MAX_SNIPPET_CHARS)}`).join('\n\n');
      }
    } catch (err) {
      logger.warn('planFirst codebase grounding search failed', String(err));
    }
  }

  const planMessages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are the planning step of an autonomous coding agent, running before it takes any action. Given the user\'s request and recent conversation, write a SHORT plan: 3-6 bullet points covering what you\'ll need to look at, what you expect to change, and in what order. Do not write actual code. Do not mention tool names or any JSON syntax — this is plain-English reasoning only, not an action. Be concrete (name files/areas if you can infer them) rather than generic.',
    },
    ...opts.recentMessages.slice(-6),
    { role: 'user', content: `${opts.userMessage}${groundingBlock}` },
  ];

  try {
    const text = await opts.ollama.chat({
      model: opts.model,
      messages: planMessages,
      temperature: 0.2,
      numCtx: opts.numCtx,
      signal: opts.signal,
    });
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return trimmed.length > MAX_PLAN_CHARS ? trimmed.slice(0, MAX_PLAN_CHARS) + '…' : trimmed;
  } catch (err) {
    logger.warn('planFirst generation failed', String(err));
    return undefined;
  }
}

/** Renders a plan-first result into the same kind of prefixed block buildTurnContextPrefix() produces, for agentLoop.ts to prepend alongside memory/project-log/milestones context. */
export function renderPlanFirstForPrompt(planText: string): string {
  return `## Your own plan for this turn (written just now, before taking any action)\n${planText}\n\nFollow this plan, but adapt if you discover it's wrong once you start investigating — it's a starting point, not a contract.`;
}
