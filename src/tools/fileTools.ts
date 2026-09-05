import * as vscode from 'vscode';
import { ToolExecContext, ToolResult } from '../agent/types';
import { isIgnoredDir, looksBinary, resolveWorkspacePath, toRelative } from '../util/paths';

const MAX_LIST_ENTRIES = 400;

export async function readFileTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const relPath: string = args.path ?? args.file ?? '';
  if (!relPath) return { ok: false, content: 'Missing required arg "path".' };

  let uri: vscode.Uri;
  try {
    uri = resolveWorkspacePath(ctx.workspaceRoot, relPath);
  } catch (err: any) {
    return { ok: false, content: err.message };
  }

  if (looksBinary(uri.fsPath)) {
    return { ok: false, content: `"${relPath}" looks like a binary file; Forge only reads text files.` };
  }

  const content = await ctx.readEffective(uri);
  if (content === undefined) {
    return { ok: false, content: `File not found: ${relPath}` };
  }

  const maxBytes = ctx.config.maxContextFileKB * 1024;
  if (Buffer.byteLength(content, 'utf8') > maxBytes && !args.start_line && !args.end_line) {
    const totalLines = content.split('\n').length;
    return {
      ok: false,
      content: `"${relPath}" is large (${totalLines} lines). Re-run read_file with start_line/end_line to page through it, e.g. {"path":"${relPath}","start_line":1,"end_line":200}.`,
    };
  }

  const lines = content.split('\n');
  const start = clamp(args.start_line ? Number(args.start_line) : 1, 1, lines.length);
  const end = clamp(args.end_line ? Number(args.end_line) : lines.length, start, lines.length);
  const width = String(end).length;
  const numbered = lines
    .slice(start - 1, end)
    .map((l, idx) => `${String(start + idx).padStart(width, ' ')}| ${l}`)
    .join('\n');

  const suffix = end < lines.length ? `\n... (${lines.length - end} more lines; page with start_line/end_line)` : '';
  return { ok: true, content: `${relPath} (lines ${start}-${end} of ${lines.length}):\n${numbered}${suffix}` };
}

export async function listDirTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const relPath: string = args.path ?? '.';
  const depth = clamp(args.depth ? Number(args.depth) : 2, 1, 4);

  let uri: vscode.Uri;
  try {
    uri = resolveWorkspacePath(ctx.workspaceRoot, relPath);
  } catch (err: any) {
    return { ok: false, content: err.message };
  }

  const entries: string[] = [];
  let truncated = false;

  async function walk(dirUri: vscode.Uri, prefix: string, remaining: number) {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return;
    }
    let children: [string, vscode.FileType][];
    try {
      children = await vscode.workspace.fs.readDirectory(dirUri);
    } catch (err) {
      return;
    }
    children.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, type] of children) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        break;
      }
      const isDir = type === 2 /* vscode.FileType.Directory */;
      if (isDir && isIgnoredDir(name)) continue;
      entries.push(`${prefix}${name}${isDir ? '/' : ''}`);
      if (isDir && remaining > 1) {
        await walk(vscode.Uri.joinPath(dirUri, name), `${prefix}${name}/`, remaining - 1);
      }
    }
  }

  await walk(uri, '', depth);
  if (entries.length === 0) {
    return { ok: true, content: `"${relPath}" is empty or does not exist.` };
  }
  return {
    ok: true,
    content: `Contents of ${relPath} (depth ${depth}):\n${entries.join('\n')}${truncated ? `\n... truncated at ${MAX_LIST_ENTRIES} entries` : ''}`,
  };
}

export async function writeFileTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const relPath: string = args.path ?? args.file ?? '';
  if (!relPath) return { ok: false, content: 'Missing required arg "path".' };

  let uri: vscode.Uri;
  try {
    uri = resolveWorkspacePath(ctx.workspaceRoot, relPath);
  } catch (err: any) {
    return { ok: false, content: err.message };
  }

  const existing = await ctx.readEffective(uri);
  const hasSearchReplace = typeof args.search === 'string' && typeof args.replace === 'string';
  const isDelete = args.delete === true;

  if (isDelete) {
    if (existing === undefined) return { ok: false, content: `Cannot delete "${relPath}": file does not exist.` };
    const { id, applied } = await ctx.proposeEdit(
      { uri, relativePath: relPath, originalText: existing, newText: '', kind: 'delete' }
    );
    return {
      ok: true,
      content: applied ? `Deleted ${relPath}.` : `Proposed deleting ${relPath} — awaiting your review in the chat panel.`,
    };
  }

  let newText: string;
  let kind: 'create' | 'modify';
  let indentAdvisory: string | undefined;
  let reindentAdvisory: string | undefined;
  let fuzzyMatchAdvisory: string | undefined;

  if (hasSearchReplace) {
    if (existing === undefined) {
      return { ok: false, content: `Cannot search/replace in "${relPath}": file does not exist. Use "content" to create it.` };
    }
    const search: string = args.search;
    const occurrences = countOccurrences(existing, search);
    let reindent: ReindentResult;
    if (occurrences === 0) {
      // Local models are weaker than frontier ones at reproducing a file's
      // exact whitespace/indentation byte-for-byte, and that's exactly the
      // case where an otherwise-correct search snippet fails outright. Before
      // giving up, retry with whitespace-normalized line matching: if every
      // line of "search" matches the corresponding line of some run in the
      // file once each side is trimmed and internal runs of whitespace are
      // collapsed, that's almost certainly the intended location — just typed
      // with different indentation. See findFuzzyLineMatches()'s doc comment
      // for the (deliberate) scope limits of this fallback.
      const fuzzyMatches = findFuzzyLineMatches(existing, search);
      if (fuzzyMatches.length === 1) {
        // Fuzzy matches are always whole lines (see findFuzzyLineMatches's
        // doc comment), so the matched region always starts at that line's
        // very first column — matchStartsAtLineStart is unconditionally true.
        reindent = reindentReplacement(existing, fuzzyMatches[0].startLine, true, args.replace);
        newText = applyFuzzyMatch(existing, fuzzyMatches[0], reindent.text);
        kind = 'modify';
        fuzzyMatchAdvisory =
          'Note: "search" did not match this file\'s content byte-for-byte, but matched once the whitespace/indentation on each line was normalized, so the edit was applied at that location anyway. Double-check the resulting indentation in the diff before treating this as done — copy it from the surrounding lines if it looks off.';
      } else if (fuzzyMatches.length > 1) {
        return {
          ok: false,
          content: `The "search" text was not found in ${relPath} byte-for-byte, and even after normalizing whitespace it still matches ${fuzzyMatches.length} places, which is ambiguous. Include more surrounding context so it uniquely identifies one location.`,
        };
      } else {
        return {
          ok: false,
          content: `The "search" text was not found in ${relPath}, even after trying a whitespace-tolerant match. It must match the file's current content (line content, ignoring pure indentation/spacing differences — no line-number gutters). Re-read the file and try a smaller, unique snippet.`,
        };
      }
    } else if (occurrences > 1) {
      return {
        ok: false,
        content: `The "search" text matches ${occurrences} places in ${relPath}, which is ambiguous. Include more surrounding context so it uniquely identifies one location.`,
      };
    } else {
      const matchIndex = existing.indexOf(search);
      const matchStartLineIndex = existing.slice(0, matchIndex).split('\n').length - 1;
      const lineStartIndex = existing.lastIndexOf('\n', matchIndex - 1) + 1;
      // Whether the match begins right at (or after only whitespace on) the
      // start of its line — i.e. whether "this line's indentation" is even a
      // meaningful concept to re-anchor the replacement onto. A "search" that
      // matches mid-line (a sub-line fragment following real code on the same
      // line) has no such anchor; see reindentReplacement()'s doc comment.
      const matchStartsAtLineStart = /^[ \t]*$/.test(existing.slice(lineStartIndex, matchIndex));
      reindent = reindentReplacement(existing, matchStartLineIndex, matchStartsAtLineStart, args.replace);
      newText = existing.replace(search, () => reindent.text);
      kind = 'modify';
    }
    // Item "whitespace and indentation issues when doing targeted writes to
    // existing files": reindentReplacement() above already does the real
    // fix — it remaps "replace"'s leading whitespace onto the file's actual
    // indent scheme, preserving the replace block's own relative nesting, and
    // writes the corrected text to disk. detectIndentMismatch() is now only
    // consulted as a residual advisory for the narrow case where
    // reindentReplacement() declined to touch anything (mid-line match, a
    // file with no indentation to sniff a scheme from, or "replace" text
    // whose own indentation is too internally inconsistent to confidently
    // reinterpret) — surfacing a heads-up instead of silently risking a
    // corrupted edit. When reindentReplacement() DID confidently rewrite
    // something, we note that instead so the diff isn't a silent surprise.
    if (!reindent.reindented) {
      indentAdvisory = detectIndentMismatch(existing, args.replace);
    } else if (reindent.text !== args.replace) {
      reindentAdvisory =
        'Note: the indentation in "replace" didn\'t match this file\'s indent style, so it was automatically remapped (same relative nesting, this file\'s tabs/spaces and width) before writing — worth a glance at the diff to confirm it landed the way you intended.';
    }
  } else if (typeof args.content === 'string') {
    newText = args.content;
    kind = existing === undefined ? 'create' : 'modify';
  } else {
    return {
      ok: false,
      content: 'write_file needs either {"content": "..."} for a full rewrite/new file, or {"search": "...", "replace": "..."} for a targeted edit.',
    };
  }

  if (existing !== undefined && newText === existing) {
    return { ok: true, content: `No changes — ${relPath} already matches the requested content.` };
  }

  // Cheap, string/comment-unaware sanity check on the resulting file as a
  // whole (not just the edited region) — see detectBalanceRegression()'s doc
  // comment for why this is deliberately conservative (only fires when the
  // file was balanced before the edit and is not after) to keep false
  // positives rare. Advisory only, same as indentAdvisory — never blocks.
  const balanceAdvisory = existing !== undefined ? detectBalanceRegression(existing, newText) : undefined;

  const { id, applied } = await ctx.proposeEdit(
    { uri, relativePath: relPath, originalText: existing ?? '', newText, kind },
    );

  const verb = kind === 'create' ? 'Created' : 'Updated';
  const verbPending = kind === 'create' ? 'creating' : 'updating';
  const advisories = [fuzzyMatchAdvisory, reindentAdvisory, indentAdvisory, balanceAdvisory].filter(Boolean);
  const advisorySuffix = advisories.length ? `\n\n${advisories.join('\n\n')}` : '';
  return {
    ok: true,
    content: applied
      ? `${verb} ${relPath}.${advisorySuffix}`
      : `Proposed ${verbPending} ${relPath} — awaiting your review in the chat panel (edit id ${id}). You may continue working; this file's content for you is now the proposed version.${advisorySuffix}`,
  };
}

/** A whitespace-normalized-line match location, expressed as an exclusive line range into the existing file's `text.split('\n')`. */
interface FuzzyLineMatch {
  startLine: number;
  endLine: number;
}

/** Trims each line and collapses internal whitespace runs to a single space, for comparison purposes only — never used to build the actual replacement text. */
function normalizeLineForMatch(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Fallback for write_file's search/replace when a byte-exact match fails:
 * looks for a contiguous run of lines in `existing` whose whitespace-
 * normalized content matches `search`'s lines, one-for-one line-count and
 * all. Deliberately scoped to WHOLE-line content — if `search`'s first or
 * last line is a fragment of a longer real line (a sub-line snippet), this
 * will not match it, since the whole real line (once normalized) won't equal
 * just the fragment. That's an intentional limit: this exists to recover
 * from the specific, common failure mode of a model retyping otherwise-
 * correct lines with the wrong indentation, not to be a general fuzzy-
 * substring matcher — a sub-line search is expected to keep working (or
 * fail) via the byte-exact path above.
 */
export function findFuzzyLineMatches(existing: string, search: string): FuzzyLineMatch[] {
  const existingLines = existing.split('\n');
  const searchLines = search.split('\n');
  const n = searchLines.length;
  if (n === 0 || existingLines.length < n) return [];
  const normSearch = searchLines.map(normalizeLineForMatch);
  // A search block that's entirely blank once normalized can't uniquely
  // locate anything — refuse rather than "matching" the first N blank lines.
  if (normSearch.every((l) => l === '')) return [];

  const matches: FuzzyLineMatch[] = [];
  for (let i = 0; i + n <= existingLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normalizeLineForMatch(existingLines[i + j]) !== normSearch[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ startLine: i, endLine: i + n });
  }
  return matches;
}

/** Splices `replace` in place of the matched line range, reconstructing the full file via line join/split — see findFuzzyLineMatches()'s doc comment for the matching rules this assumes. */
function applyFuzzyMatch(existing: string, match: FuzzyLineMatch, replace: string): string {
  const existingLines = existing.split('\n');
  const replaceLines = replace.split('\n');
  const spliced = [...existingLines.slice(0, match.startLine), ...replaceLines, ...existingLines.slice(match.endLine)];
  return spliced.join('\n');
}

/**
 * Crude, string/comment-unaware balance check: counts `{}`/`()`/`[]` across
 * the WHOLE file (not just the edited region) before and after the edit, and
 * flags a bracket type that was balanced before but isn't after. Doesn't
 * understand string literals, comments, template placeholders, or regexes —
 * a brace inside a string is counted the same as real code — so this WILL
 * occasionally false-positive; it's advisory only, exactly like
 * detectIndentMismatch(), and never blocks or alters the edit. Exported for
 * direct unit testing.
 */
export function detectBalanceRegression(existingFull: string, newFull: string): string | undefined {
  const pairs: [string, string, string][] = [
    ['{', '}', 'curly braces'],
    ['(', ')', 'parentheses'],
    ['[', ']', 'square brackets'],
  ];
  const regressed: string[] = [];
  for (const [open, close, label] of pairs) {
    const before = bracketDelta(existingFull, open, close);
    const after = bracketDelta(newFull, open, close);
    if (before === 0 && after !== 0) regressed.push(label);
  }
  if (regressed.length === 0) return undefined;
  return `Heads up: this edit appears to leave ${regressed.join(' and ')} unbalanced in the resulting file (they looked balanced before the edit). This is a crude check that doesn't understand strings/comments/regexes, so it can be a false alarm — but it's worth a second look at the diff before treating this as done.`;
}

function bracketDelta(text: string, open: string, close: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) depth--;
  }
  return depth;
}

/** 'none' means the sample had no indented lines to judge from (e.g. a one-line snippet) — callers should treat that as "can't tell," not as a mismatch. */
type DominantIndent = 'tab' | 'space' | 'none';

/**
 * Crude, dependency-free indent-style sniff: which whitespace character
 * starts more of this text's non-empty lines. Not a real indentation
 * parser — doesn't try to detect indent WIDTH, mixed-indent lines, or
 * lines indented with a leading blank-then-tab — deliberately so, since
 * this only needs to catch the common, high-confidence case ("this file is
 * clearly tabs, this replacement is clearly spaces") without false-flagging
 * on edge cases. Exported for direct unit testing.
 */
export function dominantIndentChar(text: string): DominantIndent {
  let tabs = 0;
  let spaces = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) tabs++;
    else if (line.startsWith(' ')) spaces++;
  }
  if (tabs === 0 && spaces === 0) return 'none';
  return tabs >= spaces ? 'tab' : 'space';
}

/**
 * Estimates the number of spaces per indent level in a space-indented text,
 * as the GCD of the distinct leading-space counts across its lines. Only
 * lines whose leading whitespace is PURELY spaces (no tab mixed in right
 * after the spaces) get to vote — a line with mixed leading whitespace can't
 * cleanly attest to a pure-space width. Returns undefined when no width can
 * be confidently estimated (no clean space-indented lines at all), which
 * callers should treat the same as "can't tell" rather than guessing a
 * default. Exported for direct unit testing.
 */
export function estimateSpaceIndentWidth(text: string): number | undefined {
  const counts = new Set<number>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    if (i === 0 || line[i] === '\t') continue; // unindented, or mixed leading whitespace — not a clean sample
    counts.add(i);
  }
  if (counts.size === 0) return undefined;
  let width = 0;
  for (const c of counts) width = gcd(width, c);
  return width > 0 ? width : undefined;
}

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** A resolved single indent unit: either one tab, or N spaces. */
interface IndentUnit {
  char: 'tab' | 'space';
  width: number; // 1 for tabs; the estimated per-level space count for spaces
}

/** The literal string for one level of `unit`'s indentation. */
function indentUnitString(unit: IndentUnit): string {
  return unit.char === 'tab' ? '\t' : ' '.repeat(unit.width);
}

/**
 * Combines dominantIndentChar() with estimateSpaceIndentWidth() into the
 * single indent unit reindentReplacement() re-bases text onto. Returns
 * undefined when `text` has no indented lines to sniff a scheme from at all,
 * or (space-dominant case) no line cleanly attests to a width — both "can't
 * tell" cases callers must treat as a reason to skip reindentation, not a
 * reason to assume a default like 2 or 4.
 */
function resolveIndentUnit(text: string): IndentUnit | undefined {
  const dominant = dominantIndentChar(text);
  if (dominant === 'none') return undefined;
  if (dominant === 'tab') return { char: 'tab', width: 1 };
  const width = estimateSpaceIndentWidth(text);
  return width === undefined ? undefined : { char: 'space', width };
}

/** Peels as many copies of `unit` as possible off the front of `leadingWs`, returning how many were peeled (the indent depth) and whatever's left over (ideally empty — a non-empty remainder means `leadingWs` isn't a clean whole number of `unit`s). */
function peelIndentDepth(leadingWs: string, unit: string): { depth: number; remainder: string } {
  let depth = 0;
  let rest = leadingWs;
  while (unit.length > 0 && rest.startsWith(unit)) {
    depth++;
    rest = rest.slice(unit.length);
  }
  return { depth, remainder: rest };
}

const LEADING_WS_RE = /^[ \t]*/;

/**
 * Cheap, backtick-only template-literal tracker: for each line of `text`,
 * reports whether that line STARTS inside an open template literal (i.e. a
 * `` ` `` opened on some earlier line hasn't been closed yet). Lines that
 * open and close a template literal within themselves are not flagged — only
 * a line whose OWN leading whitespace is actually part of the literal's
 * string content, where touching it would change the file's behavior, not
 * just its formatting.
 *
 * Deliberately narrow: doesn't understand escaped backticks inside a
 * `${...}` interpolation, and doesn't special-case other multi-line string
 * forms (Python triple-quotes, HEREDOCs, etc.) — a known, accepted
 * limitation rather than a general lexer. Good enough to stop reindentation
 * from corrupting the common case (a multi-line template literal in the
 * "replace" text) without the cost of a real parser.
 */
function templateLiteralLineStartMask(text: string): boolean[] {
  const lines = text.split('\n');
  const mask: boolean[] = [];
  let inTemplate = false;
  for (const line of lines) {
    mask.push(inTemplate);
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '`' && line[i - 1] !== '\\') inTemplate = !inTemplate;
    }
  }
  return mask;
}

/** Result of attempting to reindent a "replace" block onto a file's indent scheme. */
export interface ReindentResult {
  /** The text to actually write — either remapped, or `replaceText` unchanged when reindenting wasn't confidently possible. */
  text: string;
  /** True when `text` was actually remapped onto the file's indent scheme. */
  reindented: boolean;
}

/**
 * Real fix for "whitespace and indentation issues when doing targeted writes
 * to existing files" (0.10.0 shipped only an advisory warning for this —
 * this is what actually corrects it): remaps `replaceText`'s leading
 * whitespace onto the file's actual indent scheme (tab, or N spaces),
 * anchored at the indentation of the matched region's first line, while
 * PRESERVING the replace block's own relative nesting — a line that's two
 * levels deeper than replaceText's own first line stays two levels deeper
 * after remapping, just expressed in the file's indent unit.
 *
 * Algorithm:
 *  1. Sniff the file's indent unit via resolveIndentUnit(originalFileText).
 *     If the file has no indentation to sniff (or `matchStartsAtLineStart`
 *     is false — the match begins mid-line, after real code, so "this
 *     line's indentation" isn't a meaningful anchor at all), there's nothing
 *     confident to re-base onto: return replaceText untouched.
 *  2. Take the literal leading whitespace of the matched region's first line
 *     in the ORIGINAL file as the anchor (`baseIndent`), and its depth in
 *     the file's own indent unit (`baseDepth`).
 *  3. Sniff replaceText's OWN indent unit the same way. Compute every
 *     non-blank, non-template-literal line's depth in that unit, relative to
 *     replaceText's own first (non-template-literal) line.
 *  4. Confidence check: if any such line's leading whitespace isn't a clean
 *     whole number of replaceText's own unit (a leftover remainder after
 *     peeling), replaceText's indentation is too internally inconsistent to
 *     safely reinterpret as one scheme — bail out and return it untouched
 *     rather than guess and risk corrupting the file. This is the ONE case
 *     where the old advisory-only warning still fires (see
 *     detectIndentMismatch()'s doc comment).
 *  5. Otherwise, re-emit every line as `baseIndent` (replaceText's own first
 *     non-blank line, verbatim — this is what makes an already-correctly-
 *     indented replace a no-op) or
 *     `fileUnit.repeat(max(0, baseDepth + relativeDepth))` for every other
 *     line. Blank lines stay blank; lines inside a detected template literal
 *     are passed through byte-for-byte (see templateLiteralLineStartMask()).
 *
 * Exported for direct unit testing.
 */
export function reindentReplacement(
  originalFileText: string,
  matchStartLineIndex: number,
  matchStartsAtLineStart: boolean,
  replaceText: string
): ReindentResult {
  const fileUnit = matchStartsAtLineStart ? resolveIndentUnit(originalFileText) : undefined;
  if (!fileUnit) {
    return { text: replaceText, reindented: false };
  }

  const fileLines = originalFileText.split('\n');
  const anchorLine = fileLines[matchStartLineIndex] ?? '';
  const baseIndent = LEADING_WS_RE.exec(anchorLine)![0];
  const fileUnitStr = indentUnitString(fileUnit);
  const baseDepth = peelIndentDepth(baseIndent, fileUnitStr).depth;

  const replaceLines = replaceText.split('\n');
  const templateMask = templateLiteralLineStartMask(replaceText);
  const replaceUnit = resolveIndentUnit(replaceText);
  const replaceUnitStr = replaceUnit ? indentUnitString(replaceUnit) : undefined;

  const firstRealLine = replaceLines.findIndex((line, i) => !templateMask[i] && line.trim() !== '');
  const firstLineDepth =
    replaceUnitStr && firstRealLine >= 0
      ? peelIndentDepth(LEADING_WS_RE.exec(replaceLines[firstRealLine])![0], replaceUnitStr).depth
      : 0;

  // Confidence check: every non-blank, non-template-literal line must
  // decompose into a whole number of replaceText's own indent unit (or, if
  // replaceText has no sniffable unit at all, must simply have no leading
  // whitespace of its own — a genuinely flat block, unambiguous).
  for (let i = 0; i < replaceLines.length; i++) {
    if (templateMask[i]) continue;
    const line = replaceLines[i];
    if (line.trim() === '') continue;
    const ws = LEADING_WS_RE.exec(line)![0];
    if (replaceUnitStr) {
      if (peelIndentDepth(ws, replaceUnitStr).remainder !== '') {
        return { text: replaceText, reindented: false };
      }
    } else if (ws !== '') {
      return { text: replaceText, reindented: false };
    }
  }

  const outLines = replaceLines.map((line, i) => {
    if (templateMask[i]) return line;
    if (line.trim() === '') return '';
    const ws = LEADING_WS_RE.exec(line)![0];
    const content = line.slice(ws.length);
    if (i === firstRealLine) return baseIndent + content;
    const depth = replaceUnitStr ? peelIndentDepth(ws, replaceUnitStr).depth : 0;
    const relativeDepth = depth - firstLineDepth;
    const depthUnits = Math.max(0, baseDepth + relativeDepth);
    return fileUnitStr.repeat(depthUnits) + content;
  });

  return { text: outLines.join('\n'), reindented: true };
}

/**
 * Item "whitespace and indentation issues when doing targeted writes to
 * existing files": compares the existing file's dominant indent style
 * against the replacement text's, returning a human-readable advisory (or
 * undefined if there's nothing to flag — either they match, or one side has
 * no indented lines to judge from at all).
 *
 * Used to be the whole fix (0.10.0): flag a likely mismatch and let the
 * model/reviewer sort it out by hand. Since reindentReplacement() above now
 * actually corrects the common case, writeFileTool() only reaches for this
 * anymore as a residual advisory for the narrow case reindentReplacement()
 * declined to touch (see its doc comment) — the fallback still deserves a
 * heads-up even though nothing was auto-fixed. Exported for direct unit
 * testing.
 */
export function detectIndentMismatch(existing: string, replace: string): string | undefined {
  const fileIndent = dominantIndentChar(existing);
  const replaceIndent = dominantIndentChar(replace);
  if (fileIndent === 'none' || replaceIndent === 'none' || fileIndent === replaceIndent) return undefined;
  return `Heads up: this file's indentation looks like it's mostly ${fileIndent === 'tab' ? 'tabs' : 'spaces'}, but the "replace" text you provided looks like it's using ${replaceIndent === 'tab' ? 'tabs' : 'spaces'} — double-check the indentation actually matches the surrounding code before treating this edit as done.`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}

export async function getProblemsTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const relPath: string | undefined = args.path;
  const severityNames = ['Error', 'Warning', 'Information', 'Hint'];

  let all: [vscode.Uri, vscode.Diagnostic[]][];
  if (relPath) {
    let uri: vscode.Uri;
    try {
      uri = resolveWorkspacePath(ctx.workspaceRoot, relPath);
    } catch (err: any) {
      return { ok: false, content: err.message };
    }
    all = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    all = vscode.languages.getDiagnostics();
  }

  const lines: string[] = [];
  for (const [uri, diags] of all) {
    if (!diags || diags.length === 0) continue;
    const rel = toRelative(ctx.workspaceRoot, uri);
    if (isIgnoredDir(rel.split('/')[0])) continue;
    for (const d of diags) {
      const sev = severityNames[d.severity] ?? 'Info';
      const line = (d.range?.start?.line ?? 0) + 1;
      lines.push(`${rel}:${line} [${sev}] ${d.message}`);
    }
  }

  if (lines.length === 0) {
    return { ok: true, content: relPath ? `No problems reported for ${relPath}.` : 'No problems reported in the workspace.' };
  }
  return { ok: true, content: `${lines.length} problem(s):\n${lines.slice(0, 100).join('\n')}` };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
