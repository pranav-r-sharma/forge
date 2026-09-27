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

const INLINE_CODE_RE = /`([^`]+)`/g;

const SHELL_LEAD_RE =
  /^(?:\.\/|python3?|node|npm|npx|pytest|go|cargo|make|bash|sh)\b/i;

const UNIVERSAL_FILE_CLAIM_RE =
  /\b(?:all|every|each|both)\b[^.\n]{0,40}\bfiles?\b|\b(?:five|5|four|4|three|3|two|2)\b[^.\n]{0,20}\bfiles?\b/i;

export function normalizeCommandWhitespace(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function extractClaimedPaths(finalText: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  CLAIM_RE.lastIndex = 0;
  while ((m = CLAIM_RE.exec(finalText))) {
    found.add(m[1]);
  }
  return [...found];
}

/** Inline backtick spans that look like shell commands the model says it ran. */
export function extractClaimedCommands(finalText: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  INLINE_CODE_RE.lastIndex = 0;
  while ((m = INLINE_CODE_RE.exec(finalText))) {
    const span = m[1].trim();
    if (!span || span.includes('\n')) continue;
    if (SHELL_LEAD_RE.test(span) || /\s-m\s/.test(span)) {
      found.add(span);
    }
  }
  return [...found];
}

export function commandWasExecuted(claimed: string, executedCommands: string[]): boolean {
  const normClaimed = normalizeCommandWhitespace(claimed);
  if (!normClaimed) return false;
  for (const raw of executedCommands) {
    const normExec = normalizeCommandWhitespace(raw);
    if (normExec === normClaimed || normExec.startsWith(normClaimed + ' ')) {
      return true;
    }
  }
  return false;
}

export function findUnrunClaimedCommands(finalText: string, executedCommands: string[]): string[] {
  return extractClaimedCommands(finalText).filter((c) => !commandWasExecuted(c, executedCommands));
}

export function finalAnswerMakesUniversalFileClaim(finalText: string): boolean {
  return UNIVERSAL_FILE_CLAIM_RE.test(finalText);
}

function extensionOf(filePath: string): string {
  const i = filePath.lastIndexOf('.');
  return i >= 0 ? filePath.slice(i).toLowerCase() : '';
}

/** Remove a workspace-relative path from a command string to get a per-file command template. */
export function perFileCommandTemplate(command: string, filePath: string): string | undefined {
  const norm = normalizeCommandWhitespace(command);
  const variants = [filePath, filePath.replace(/^\.\//, '')];
  for (const v of variants) {
    if (!v) continue;
    if (!norm.includes(v)) continue;
    const stripped = normalizeCommandWhitespace(norm.replace(v, '').replace(/\s+/g, ' ').trim());
    return stripped || undefined;
  }
  return undefined;
}

/**
 * Files written/edited this turn that share an extension with a per-file command
 * template but never received that command. Only meaningful when paired with
 * `finalAnswerMakesUniversalFileClaim`.
 */
function isPerFileVerificationCommand(command: string): boolean {
  const norm = normalizeCommandWhitespace(command);
  return /\s-m\s+py_compile\b/i.test(norm);
}

/** Paths that count toward per-file verification coverage (skip package __init__ stubs). */
export function filesForPerFileVerification(filesWrittenThisTurn: string[]): string[] {
  return [...new Set(filesWrittenThisTurn.filter((f) => f && !/(?:^|\/)__init__\.py$/i.test(f)))];
}

export function findPerFileCommandGaps(
  executedCommands: string[],
  filesWrittenThisTurn: string[],
): { template: string; uncovered: string[] }[] {
  const written = filesForPerFileVerification(filesWrittenThisTurn);
  if (written.length === 0) return [];

  const coveredByTemplate = new Map<string, Set<string>>();

  for (const cmd of executedCommands) {
    if (!isPerFileVerificationCommand(cmd)) continue;
    const norm = normalizeCommandWhitespace(cmd);
    for (const file of written) {
      if (!norm.includes(file) && !norm.includes(file.replace(/^\.\//, ''))) continue;
      const template = perFileCommandTemplate(norm, file);
      if (!template) continue;
      let set = coveredByTemplate.get(template);
      if (!set) {
        set = new Set();
        coveredByTemplate.set(template, set);
      }
      set.add(file);
    }
  }

  const gaps: { template: string; uncovered: string[] }[] = [];
  for (const [template, covered] of coveredByTemplate) {
    const ext = extensionOf([...covered][0] ?? '');
    if (!ext) continue;
    const sameExt = written.filter((f) => extensionOf(f) === ext);
    const uncovered = sameExt.filter((f) => !covered.has(f));
    if (uncovered.length > 0) gaps.push({ template, uncovered });
  }
  return gaps;
}

export interface ClaimedCommandCheck {
  unrunCommands: string[];
  perFileGaps: { template: string; uncovered: string[] }[];
  nudgeMessage: string;
  unverifiedMarkers: string[];
}

export function evaluateClaimedCommands(
  finalText: string,
  executedCommands: string[],
  filesWrittenThisTurn: string[],
): ClaimedCommandCheck {
  const unrunCommands = findUnrunClaimedCommands(finalText, executedCommands);
  const perFileGaps = finalAnswerMakesUniversalFileClaim(finalText)
    ? findPerFileCommandGaps(executedCommands, filesWrittenThisTurn)
    : [];

  const parts: string[] = [];
  for (const cmd of unrunCommands) {
    parts.push(`Your summary says you ran \`${cmd}\`, but it was never run this session.`);
  }
  const verificationFiles = filesForPerFileVerification(filesWrittenThisTurn);
  for (const gap of perFileGaps) {
    const ext = extensionOf(gap.uncovered[0] ?? '');
    const totalSameExt = verificationFiles.filter((f) => extensionOf(f) === ext).length;
    const ranOn = totalSameExt - gap.uncovered.length;
    parts.push(
      `You ran \`${gap.template}\` on ${ranOn} of the ${totalSameExt} \`${ext}\` files you wrote; never on: ${gap.uncovered.join(', ')}.`,
    );
  }
  const nudgeMessage =
    parts.length > 0
      ? `[System check] ${parts.join(' ')} Run the missing command(s) now, or correct your summary.`
      : '';

  const unverifiedMarkers: string[] = [];
  for (const cmd of unrunCommands) unverifiedMarkers.push(`command not run: ${cmd}`);
  for (const gap of perFileGaps) {
    for (const f of gap.uncovered) unverifiedMarkers.push(`per-file check missing: ${gap.template} → ${f}`);
  }

  return { unrunCommands, perFileGaps, nudgeMessage, unverifiedMarkers };
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

/** Parse run_command / write_file paths from a saved message transcript (tests, e2e fixtures). */
export function collectTurnToolFacts(messages: ChatMessage[]): {
  executedCommands: string[];
  filesWritten: string[];
} {
  const executedCommands: string[] = [];
  const filesWritten: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const re = /```forge_action\s*([\s\S]*?)```/gi;
    let block: RegExpExecArray | null;
    while ((block = re.exec(m.content))) {
      const inner = block[1].trim();
      try {
        const parsed = JSON.parse(inner) as { tool?: string; args?: Record<string, unknown> };
        if (parsed.tool === 'run_command' && typeof parsed.args?.command === 'string') {
          executedCommands.push(parsed.args.command);
        }
        if (parsed.tool === 'write_file' && typeof parsed.args?.path === 'string') {
          filesWritten.push(parsed.args.path);
        }
      } catch {
        // tolerate malformed fragments in fixtures
      }
    }
  }
  return { executedCommands, filesWritten };
}
