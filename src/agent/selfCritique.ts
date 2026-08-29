import { OllamaClient } from '../ollama/client';
import { logger } from '../util/logger';

const MAX_SNIPPET_CHARS = 3000;

/**
 * Whether a proposed write_file call is "non-trivial" enough to warrant a
 * self-critique pass (`forge.selfCritique.enabled`, off by default) — a
 * cheap line-count heuristic over the tool call's own args, not a real diff
 * (no read of the file's prior content needed to decide whether to even
 * bother). Deliberately approximate: it only sees what's being WRITTEN
 * (`content` or `replace`), not what's being removed, so a huge deletion
 * disguised as a tiny `replace` won't trigger this — that's an accepted
 * scope limit for keeping this a zero-cost check on every call.
 */
export function shouldCritique(args: Record<string, any>, minLines: number): boolean {
  if (args?.delete === true) return false;
  const text: string = typeof args?.content === 'string' ? args.content : typeof args?.replace === 'string' ? args.replace : '';
  if (!text) return false;
  return text.split('\n').length >= minLines;
}

/**
 * Asymmetric bet behind this feature (per the "verification is cheaper than
 * generation" observation): a small/local model is often noticeably better
 * at judging "does this diff look right" than it was at producing the diff
 * in the first place, since critique is a narrower, more constrained
 * question. One extra, tightly-scoped model call (no tool schema, capped
 * output) asking specifically "does this look correct" after a non-trivial
 * edit, folded into that edit's own tool result so the SAME agent turn can
 * react to it immediately rather than only a human noticing later.
 *
 * Always best-effort: a failure here (unreachable model, cancellation)
 * returns undefined and the edit proceeds exactly as if self-critique were
 * off — this is advisory tooling, never a gate that can block or roll back
 * an edit the pending-edit review system already handles.
 */
export async function critiqueEdit(opts: {
  ollama: OllamaClient;
  model: string;
  path: string;
  writtenText: string;
  isFullRewrite: boolean;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const snippet = opts.writtenText.length > MAX_SNIPPET_CHARS ? opts.writtenText.slice(0, MAX_SNIPPET_CHARS) + '\n...(truncated)' : opts.writtenText;
  const kind = opts.isFullRewrite ? 'a full-file rewrite of' : 'a targeted replacement snippet within';
  try {
    const text = await opts.ollama.chat({
      model: opts.model,
      messages: [
        {
          role: 'system',
          content:
            'You are reviewing a code change someone (another instance of you, mid-task) is about to apply, purely for obvious mistakes: syntax errors, unbalanced brackets, an accidentally-duplicated or accidentally-deleted block, an obviously broken control-flow structure, a clear logic inversion. If it looks fine, reply with exactly: OK. If something looks wrong, reply with ONE short sentence naming the specific concern — do not rewrite the code, do not restate the whole snippet, do not hedge with generic advice like "make sure to test this."',
        },
        { role: 'user', content: `This is ${kind} "${opts.path}":\n\n\`\`\`\n${snippet}\n\`\`\`` },
      ],
      temperature: 0.1,
      maxTokens: 150,
      signal: opts.signal,
    });
    const trimmed = text.trim();
    if (!trimmed || /^ok\.?$/i.test(trimmed)) return undefined;
    return trimmed.length > 400 ? trimmed.slice(0, 400) + '…' : trimmed;
  } catch (err) {
    logger.warn('self-critique pass failed', String(err));
    return undefined;
  }
}
