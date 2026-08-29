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
  let fuzzyMatchAdvisory: string | undefined;

  if (hasSearchReplace) {
    if (existing === undefined) {
      return { ok: false, content: `Cannot search/replace in "${relPath}": file does not exist. Use "content" to create it.` };
    }
    const search: string = args.search;
    const occurrences = countOccurrences(existing, search);
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
        newText = applyFuzzyMatch(existing, fuzzyMatches[0], args.replace);
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
      newText = existing.replace(search, () => args.replace);
      kind = 'modify';
    }
    // Item "whitespace and indentation issues when doing targeted writes to
    // existing files": advisory only — never blocks the edit or mutates
    // newText, since a false positive (e.g. a one-line replacement with no
    // indentation of its own) must never stop a legitimate edit. This just
    // surfaces a heads-up in the tool result so the model (or a human
    // reviewing the proposed diff) notices a likely tabs/spaces mismatch
    // instead of it silently landing in the file.
    indentAdvisory = detectIndentMismatch(existing, args.replace);
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
  const advisories = [fuzzyMatchAdvisory, indentAdvisory, balanceAdvisory].filter(Boolean);
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
 * Item "whitespace and indentation issues when doing targeted writes to
 * existing files": compares the existing file's dominant indent style
 * against the replacement text's, returning a human-readable advisory (or
 * undefined if there's nothing to flag — either they match, or one side has
 * no indented lines to judge from at all). Exported for direct unit testing.
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
