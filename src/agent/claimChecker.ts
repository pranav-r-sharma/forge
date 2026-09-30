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

/** Template with every listed path removed (for one command that names multiple written files). */
export function perFileCommandTemplateStripPaths(command: string, filePaths: string[]): string | undefined {
  let norm = normalizeCommandWhitespace(command);
  let removed = 0;
  for (const filePath of filePaths) {
    for (const v of [filePath, filePath.replace(/^\.\//, '')]) {
      if (!v || !norm.includes(v)) continue;
      norm = normalizeCommandWhitespace(norm.replace(v, ''));
      removed++;
      break;
    }
  }
  if (removed === 0) return undefined;
  return norm || undefined;
}

/** Executables whose per-file use is never treated as a verification template. */
const NON_CHECK_EXECUTABLES = new Set([
  'cat',
  'ls',
  'rm',
  'mv',
  'cp',
  'echo',
  'head',
  'tail',
  'wc',
]);

const INTERPRETER_EXECUTABLES = new Set([
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'deno',
  'bun',
  'lua',
  'rscript',
  'ts-node',
  'tsx',
]);

/** Options after which there is no script operand (later positionals are per-file targets). */
const INTERPRETER_MODULE_OR_CODE_OPTS = new Set([
  '-m',
  '-c',
  '-e',
  '--eval',
  '-p',
  '--print',
]);

export function isInterpreterExecutable(leafName: string): boolean {
  const leaf = leafName.replace(/^\.\//, '').split('/').pop() ?? leafName;
  const lower = leaf.toLowerCase();
  if (INTERPRETER_EXECUTABLES.has(lower)) return true;
  return /^python3\.\d+$/i.test(lower);
}

function pathsReferToSameFile(filePath: string, token: string): boolean {
  const a = filePath.replace(/^\.\//, '');
  const b = token.replace(/^\.\//, '');
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

function writtenFileAppearsAsCommandToken(command: string, filePath: string): boolean {
  for (const tok of tokenizeShellCommand(command)) {
    if (pathsReferToSameFile(filePath, tok)) return true;
  }
  return false;
}

function interpreterOptionConsumesNextToken(optToken: string): boolean {
  const opt = (optToken.includes('=') ? optToken.split('=')[0] : optToken)!.toLowerCase();
  return INTERPRETER_MODULE_OR_CODE_OPTS.has(opt);
}

/** First positional after the interpreter when not in -m / -c / … mode; otherwise undefined. */
export function getInterpreterScriptOperandToken(command: string): string | undefined {
  const tokens = tokenizeShellCommand(normalizeCommandWhitespace(command));
  if (tokens.length < 2) return undefined;
  const exeLeaf = tokens[0]!.replace(/^\.\//, '').split('/').pop() ?? '';
  if (!isInterpreterExecutable(exeLeaf)) return undefined;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      const opt = (t.includes('=') ? t.split('=')[0] : t)!.toLowerCase();
      if (INTERPRETER_MODULE_OR_CODE_OPTS.has(opt)) return undefined;
      i++;
      if (interpreterOptionConsumesNextToken(t) && i < tokens.length && !tokens[i]!.startsWith('-') && !t.includes('=')) {
        i++;
      }
      continue;
    }
    return t;
  }
  return undefined;
}

/**
 * Whether an interpreter command's script operand counts as a per-file verification target.
 * Running a program (e.g. `python3 main.py -h`, `node app.js --help`) is not a per-file check.
 * Check-style runs count when an option precedes the script and it is the last token
 * (e.g. `node --check a.js`, `bash -n a.sh`). Known edge: `python3 -u main.py` counts as a check.
 */
export function scriptOperandIsCheckTarget(command: string): boolean {
  const tokens = tokenizeShellCommand(normalizeCommandWhitespace(command));
  if (tokens.length < 2) return false;
  const exeLeaf = tokens[0]!.replace(/^\.\//, '').split('/').pop() ?? '';
  if (!isInterpreterExecutable(exeLeaf)) return false;

  let i = 1;
  let hadOption = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      hadOption = true;
      const opt = (t.includes('=') ? t.split('=')[0] : t)!.toLowerCase();
      if (INTERPRETER_MODULE_OR_CODE_OPTS.has(opt)) return false;
      i++;
      if (interpreterOptionConsumesNextToken(t) && i < tokens.length && !tokens[i]!.startsWith('-') && !t.includes('=')) {
        i++;
      }
      continue;
    }
    break;
  }
  if (i >= tokens.length) return false;
  if (i < tokens.length - 1) return false;
  return hadOption;
}

function interpreterScriptPathIndex(command: string): number | undefined {
  const tokens = tokenizeShellCommand(normalizeCommandWhitespace(command));
  if (tokens.length < 2) return undefined;
  const exeLeaf = tokens[0]!.replace(/^\.\//, '').split('/').pop() ?? '';
  if (!isInterpreterExecutable(exeLeaf)) return undefined;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      const opt = (t.includes('=') ? t.split('=')[0] : t)!.toLowerCase();
      if (INTERPRETER_MODULE_OR_CODE_OPTS.has(opt)) return undefined;
      i++;
      if (interpreterOptionConsumesNextToken(t) && i < tokens.length && !tokens[i]!.startsWith('-') && !t.includes('=')) {
        i++;
      }
      continue;
    }
    return i;
  }
  return undefined;
}

function writtenFileIsNonCheckScriptOperand(command: string, filePath: string): boolean {
  const script = getInterpreterScriptOperandToken(command);
  if (!script || !pathsReferToSameFile(filePath, script)) return false;
  if (scriptOperandIsCheckTarget(command)) return false;

  const scriptIdx = interpreterScriptPathIndex(command);
  if (scriptIdx === undefined) return false;
  const tokens = tokenizeShellCommand(normalizeCommandWhitespace(command));
  if (scriptIdx >= tokens.length - 1) return true;

  for (let j = scriptIdx + 1; j < tokens.length; j++) {
    const f = tokens[j]!;
    if (f.startsWith('-')) return true;
    if (!/\.[A-Za-z0-9]{1,10}$/.test(f)) return true;
  }
  return false;
}

function baseExecutable(command: string): string {
  const first = normalizeCommandWhitespace(command).split(/\s+/)[0] ?? '';
  const leaf = first.replace(/^\.\//, '').split('/').pop() ?? first;
  return leaf.toLowerCase();
}

const BARE_EXECUTABLE_ONLY = new Set(['python3', 'python', 'node', 'bash', 'sh']);

/** Split a shell command into tokens; quoted segments count as one token. */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const s = command.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      i++;
      const start = i;
      while (i < s.length && s[i] !== ch) {
        if (s[i] === '\\' && i + 1 < s.length) i += 2;
        else i++;
      }
      tokens.push(s.slice(start, i));
      if (i < s.length) i++;
      continue;
    }
    const start = i;
    while (i < s.length && !/\s/.test(s[i]!)) i++;
    tokens.push(s.slice(start, i));
  }
  return tokens;
}

/**
 * After the executable, only flags/options and their values — no bare positional args
 * (so `python3 -m py_compile` ok, `python3 demo` / `python3 main.py demo` not).
 */
export function templateHasOnlyFlagsAfterExecutable(template: string): boolean {
  const tokens = tokenizeShellCommand(template);
  if (tokens.length === 0) return false;
  const exeLeaf = tokens[0]!.replace(/^\.\//, '').split('/').pop()?.toLowerCase() ?? '';
  if (tokens.length === 1 && BARE_EXECUTABLE_ONLY.has(exeLeaf)) return false;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      i++;
      if (i < tokens.length && !tokens[i]!.startsWith('-')) i++;
      continue;
    }
    return false;
  }
  return true;
}

/** True when a stripped command still looks like a per-file check (not cat/ls/…). */
export function isPerFileVerificationTemplate(template: string): boolean {
  const norm = normalizeCommandWhitespace(template);
  if (!norm) return false;
  if (NON_CHECK_EXECUTABLES.has(baseExecutable(norm))) return false;
  if (!templateHasOnlyFlagsAfterExecutable(norm)) return false;
  return true;
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
    const norm = normalizeCommandWhitespace(cmd);
    const pathsInCmd = written.filter((file) => {
      if (!writtenFileAppearsAsCommandToken(norm, file)) return false;
      if (writtenFileIsNonCheckScriptOperand(norm, file)) return false;
      return true;
    });
    if (pathsInCmd.length === 0) continue;
    const template = perFileCommandTemplateStripPaths(norm, pathsInCmd);
    if (!template || !isPerFileVerificationTemplate(template)) continue;
    let set = coveredByTemplate.get(template);
    if (!set) {
      set = new Set();
      coveredByTemplate.set(template, set);
    }
    for (const file of pathsInCmd) set.add(file);
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
  nudgeTraceNote: 'claimed-command-nudge' | undefined;
}

/** Shell command forms from the user task (inline code spans with the same heuristic as claimed commands). */
export function extractTaskCommandForms(taskText: string): string[] {
  return extractClaimedCommands(taskText);
}

export function isTaskFormPlaceholder(token: string): boolean {
  if (token === '...') return true;
  if (/^YYYY-MM-DD$/i.test(token)) return true;
  if (/^<[^>]+>$/.test(token)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(token)) return true;
  return false;
}

function tokensMatchTaskForm(formTokens: string[], execTokens: string[]): boolean {
  let f = [...formTokens];
  let allowExtra = false;
  if (f[f.length - 1] === '...') {
    allowExtra = true;
    f.pop();
  }
  return matchTaskFormTokens(f, 0, execTokens, 0, allowExtra);
}

function matchTaskFormTokens(
  f: string[],
  fi: number,
  e: string[],
  ei: number,
  allowExtraTail: boolean,
): boolean {
  if (fi >= f.length) {
    if (ei === e.length) return true;
    return allowExtraTail;
  }
  if (f[fi] === '<file>') {
    if (ei >= e.length) return false;
    const restStart = fi + 1;
    if (restStart >= f.length) {
      // One <file> placeholder may expand to several path tokens at the end of the command.
      return ei < e.length && matchTaskFormTokens(f, restStart, e, e.length, allowExtraTail);
    }
    for (let k = 1; k <= e.length - ei; k++) {
      if (matchTaskFormTokens(f, restStart, e, ei + k, allowExtraTail)) return true;
    }
    return false;
  }
  if (ei >= e.length) return false;
  if (!taskFormTokensEquivalent(f[fi]!, e[ei]!, fi, f)) return false;
  return matchTaskFormTokens(f, fi + 1, e, ei + 1, allowExtraTail);
}

function taskFormTokensEquivalent(formTok: string, execTok: string, formIndex: number, formTokens: string[]): boolean {
  if (formTok === execTok) return true;
  if (formTok.startsWith('-')) return formTok === execTok;
  if (formTok === 'python3' || formTok === 'main.py') return formTok === execTok;
  if (formIndex === 2 && formTokens[0] === 'python3' && formTokens[1] === 'main.py') {
    return formTok === execTok;
  }
  if (isTaskFormPlaceholder(formTok)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(formTok) && /^\d{4}-\d{2}-\d{2}$/.test(execTok)) return true;
  if (/^\d+\.?\d*$/.test(formTok) && /^\d+\.?\d*$/.test(execTok)) return true;
  return true;
}

/** True when an executed command matches a task form: same tokens in order (wildcards; multi-file `<file>`). */
export function commandMatchesTaskForm(form: string, executed: string): boolean {
  const f = tokenizeShellCommand(normalizeCommandWhitespace(form));
  const e = tokenizeShellCommand(normalizeCommandWhitespace(executed));
  return tokensMatchTaskForm(f, e);
}

/** Inner command from `bash -lc "…"` / `sh -c '…'` wrappers (one level). */
export function unwrapShellWrapper(command: string): string | undefined {
  const tokens = tokenizeShellCommand(normalizeCommandWhitespace(command));
  if (tokens.length < 3) return undefined;
  const exe = tokens[0]!.replace(/^\.\//, '').split('/').pop()?.toLowerCase() ?? '';
  if (exe !== 'bash' && exe !== 'sh' && exe !== 'zsh') return undefined;
  const flag = tokens[1]!.toLowerCase();
  if (flag !== '-c' && flag !== '-lc') return undefined;
  const inner = tokens.slice(2).join(' ').trim();
  return inner || undefined;
}

export function expandExecutedCommandsForTaskMatch(executedCommands: string[]): string[] {
  const out: string[] = [];
  for (const cmd of executedCommands) {
    out.push(cmd);
    const inner = unwrapShellWrapper(cmd);
    if (inner) out.push(inner);
  }
  return out;
}

export function findUnexercisedTaskForms(taskForms: string[], executedCommands: string[]): string[] {
  const expanded = expandExecutedCommandsForTaskMatch(executedCommands);
  return taskForms.filter((form) => !expanded.some((exec) => commandMatchesTaskForm(form, exec)));
}

/** Whether another task-form nudge is allowed (max 3 per turn; re-nudge only after progress). */
export function shouldSendTaskCommandNudge(
  unexercised: string[],
  previousUnexercised: string[] | undefined,
  nudgesAlreadySent: number,
): boolean {
  if (unexercised.length === 0) return false;
  if (nudgesAlreadySent >= 3) return false;
  if (nudgesAlreadySent === 0) return true;
  if (previousUnexercised === undefined) return true;
  return unexercised.length < previousUnexercised.length;
}

export function taskCommandFormUnverifiedMarkers(unexercised: string[]): string[] {
  return unexercised.map((form) => `task command form not run: ${form}`);
}

export function formatTaskCommandNudge(unexercised: string[]): string {
  const list = unexercised.map((c) => `\`${c}\``).join(', ');
  return `[System check] The task specifies these command forms, but you never ran a command matching them: ${list}. Run them as written (fix the code if they fail), or explain why not.`;
}

/** Claimed-command / per-file verification gaps only — task command forms are handled separately in agentLoop (formatTaskCommandNudge). */
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

  const nudgeTraceNote: ClaimedCommandCheck['nudgeTraceNote'] =
    unrunCommands.length > 0 || perFileGaps.length > 0 ? 'claimed-command-nudge' : undefined;

  return { unrunCommands, perFileGaps, nudgeMessage, unverifiedMarkers, nudgeTraceNote };
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
export type UnresolvedRunFailure = {
  command: string;
  exitCode: number | null;
  filesEditedAfter: string[];
  /** First lines of the failed command's tool output (for loop-warning context). */
  outputSnippet?: string;
};

/** Parse exit code from a run_command tool result body (undefined when the command never ran). */
export function parseRunCommandExitCode(resultContent: string): number | null {
  const m = /\(exit code: (\d+)\)/.exec(resultContent);
  return m ? Number(m[1]) : null;
}

export function formatUnresolvedFailureNudge(failure: UnresolvedRunFailure): string {
  const exitPart =
    failure.exitCode !== null ? ` (exit ${failure.exitCode})` : '';
  const editPart =
    failure.filesEditedAfter.length > 0
      ? `; you then edited: ${failure.filesEditedAfter.join(', ')}`
      : '';
  return `[System check] Your last command \`${failure.command}\` failed${exitPart} and has not been rerun successfully since${editPart}. Rerun it now and fix what fails, or explain why the failure is acceptable.`;
}

export function unresolvedFailureMarker(failure: UnresolvedRunFailure): string {
  return `unresolved failed command: ${failure.command}`;
}

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
