import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { ToolExecContext, ToolResult } from '../agent/types';
import { requireStringArg } from './argErrors';
import { looksBinary, PathOutsideWorkspaceError, resolveWorkspacePath, toRelative } from '../util/paths';

const MAX_FILES_SCANNED = 10_000;
const DEFAULT_MAX_MATCHES = 500;
const MAX_FILE_KB_FOR_SEARCH = 8192;
const DEFAULT_EXCLUDE_GLOBS = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'venv',
  '.venv',
  '__pycache__',
  'coverage',
  'target',
];

type SearchMode = 'lines' | 'files' | 'count' | 'extract';

interface LineHit {
  rel: string;
  line: number;
  text: string;
  context?: boolean;
}

interface ParsedSearch {
  query: string;
  regex: RegExp;
  regexSource: string;
  fixedString: boolean;
  literalPattern: string;
  wholeWord: boolean;
  caseInsensitive: boolean;
  mode: SearchMode;
  globIncludes: string[];
  excludeGlobs: string[];
  searchRoots: vscode.Uri[];
  singleFileRel?: string;
  contextLines: number;
  maxResults: number;
  maxExtractLines: number;
  multiline: boolean;
}

export async function searchCodeTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const queryCheck = requireStringArg(
    'search_code',
    'query',
    args.query ?? args.pattern,
    'Missing required arg "query".',
  );
  if (!queryCheck.ok) return { ok: false, content: queryCheck.content };

  let parsed: ParsedSearch;
  try {
    parsed = parseSearchArgs(queryCheck.value, args, ctx);
  } catch (err: any) {
    if (err instanceof PathOutsideWorkspaceError) {
      return { ok: false, content: err.message };
    }
    return { ok: false, content: String(err.message || err) };
  }

  if (parsed.mode === 'extract' && !parsed.singleFileRel) {
    return { ok: false, content: 'search_code mode "extract" requires arg "path" pointing to a single workspace file.' };
  }

  let hits: LineHit[];
  let perFileCounts: Map<string, number> | undefined;
  try {
    const rg = findRipgrepBinary();
    if (rg) {
      const rgOut = await runRipgrep(rg, parsed, ctx);
      if (rgOut.ok) {
        hits = rgOut.hits;
        perFileCounts = rgOut.perFileCounts;
      } else if (rgOut.fallback) {
        const js = await runJsScan(parsed, ctx);
        hits = js.hits;
        perFileCounts = js.perFileCounts;
      } else {
        return { ok: false, content: rgOut.error || 'search_code failed.' };
      }
    } else {
      const js = await runJsScan(parsed, ctx);
      hits = js.hits;
      perFileCounts = js.perFileCounts;
    }
  } catch (err: any) {
    return { ok: false, content: `search_code failed: ${err.message || err}` };
  }

  return formatSearchResult(parsed, hits, perFileCounts, ctx);
}

function parseSearchArgs(query: string, args: Record<string, any>, ctx: ToolExecContext): ParsedSearch {
  const mode = normalizeMode(args.mode);
  const maxResults = clampInt(args.maxResults, DEFAULT_MAX_MATCHES, 1, 10_000);
  const maxExtractLines = clampInt(args.maxLines, 200, 1, 2000);
  const contextLines = clampInt(args.context, 0, 0, 10);
  // `/re/flags` keeps its own case rule (case-sensitive unless it has `i`, as before this tool grew flags) unless caseSensitive is given.
  const slashQuery = /^\/(.*)\/([a-z]*)$/i.exec(query);
  const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : slashQuery ? !slashQuery[2].includes('i') : false;
  const useRegexArg = args.regex === true;
  const wholeWord = args.wholeWord === true;
  const multiline = args.multiline === true;

  const patternInfo = buildPattern(query, useRegexArg, caseSensitive, wholeWord, multiline);
  if (!patternInfo.ok) {
    throw new Error(patternInfo.error);
  }

  const globIncludes = normalizeGlobs(args.include ?? args.glob ?? '**/*');
  const extraExclude = normalizeGlobs(args.exclude ?? []);
  const excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...extraExclude.map((g) => g.replace(/^\*\*\//, ''))];

  const { searchRoots, singleFileRel } = resolveSearchScope(args.path, ctx.workspaceRoot);

  return {
    query,
    regex: patternInfo.regex,
    regexSource: patternInfo.regexSource,
    fixedString: patternInfo.fixedString,
    literalPattern: patternInfo.literalPattern,
    wholeWord,
    caseInsensitive: !caseSensitive,
    mode,
    globIncludes,
    excludeGlobs,
    searchRoots,
    singleFileRel,
    contextLines,
    maxResults,
    maxExtractLines,
    multiline,
  };
}

function normalizeMode(v: unknown): SearchMode {
  const m = String(v || 'lines').toLowerCase();
  if (m === 'files' || m === 'count' || m === 'extract' || m === 'lines') return m;
  return 'lines';
}

function normalizeGlobs(v: unknown): string[] {
  if (!v) return ['**/*'];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)];
}

function resolveSearchScope(pathArg: unknown, workspaceRoot: vscode.Uri): { searchRoots: vscode.Uri[]; singleFileRel?: string } {
  if (pathArg === undefined || pathArg === null || pathArg === '') {
    return { searchRoots: [workspaceRoot] };
  }
  const rel = String(pathArg).replace(/^\/+/, '');
  const uri = resolveWorkspacePath(workspaceRoot, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(uri.fsPath);
  } catch {
    throw new Error(`search_code path "${rel}" does not exist in the workspace.`);
  }
  if (st.isFile()) {
    return { searchRoots: [uri], singleFileRel: toRelative(workspaceRoot, uri) };
  }
  return { searchRoots: [uri] };
}

type PatternOk = { ok: true; regex: RegExp; regexSource: string; fixedString: boolean; literalPattern: string };
type PatternErr = { ok: false; error: string };

function buildPattern(
  query: string,
  useRegexArg: boolean,
  caseSensitive: boolean,
  wholeWord: boolean,
  multiline: boolean,
): PatternOk | PatternErr {
  const slashMatch = /^\/(.*)\/([a-z]*)$/i.exec(query);
  let source: string;
  let flags = '';
  let fixedString = false;
  let literalPattern = query;

  if (slashMatch) {
    source = slashMatch[1];
    literalPattern = source;
    if (slashMatch[2].includes('i')) flags += 'i';
    if (slashMatch[2].includes('m')) flags += 'm';
    if (slashMatch[2].includes('s')) flags += 's';
  } else if (useRegexArg) {
    source = query;
    literalPattern = query;
    if (!caseSensitive) flags += 'i';
  } else {
    source = escapeRegExp(query);
    fixedString = true;
    literalPattern = query;
    if (!caseSensitive) flags += 'i';
  }

  if (!caseSensitive && !flags.includes('i')) flags += 'i';
  if (caseSensitive) flags = flags.replace(/i/g, '');
  if (multiline) {
    if (!flags.includes('m')) flags += 'm';
    if (!flags.includes('s')) flags += 's';
  }
  if (wholeWord && fixedString) {
    source = `\\b${source}\\b`;
    fixedString = false;
  } else if (wholeWord && !fixedString) {
    source = `\\b(?:${source})\\b`;
  }

  try {
    const regex = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    return { ok: true, regex, regexSource: source, fixedString, literalPattern };
  } catch (e: any) {
    if (useRegexArg) {
      return { ok: false, error: `search_code: invalid regex: ${e.message || e}` };
    }
    if (slashMatch) {
      return {
        ok: true,
        regex: new RegExp(escapeRegExp(query), 'gi'),
        regexSource: escapeRegExp(query),
        fixedString: true,
        literalPattern: query,
      };
    }
    return {
      ok: true,
      regex: new RegExp(escapeRegExp(query), 'gi'),
      regexSource: escapeRegExp(query),
      fixedString: true,
      literalPattern: query,
    };
  }
}

function findRipgrepBinary(): string | undefined {
  const appRoot = vscode.env.appRoot;
  if (!appRoot) return undefined;
  const names = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
  const bases = [
    path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin'),
    path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin'),
  ];
  for (const base of bases) {
    for (const n of names) {
      const p = path.join(base, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* try next */
      }
    }
  }
  return undefined;
}

async function runRipgrep(
  rgPath: string,
  parsed: ParsedSearch,
  ctx: ToolExecContext,
): Promise<{ ok: true; hits: LineHit[]; perFileCounts: Map<string, number> } | { ok: false; fallback?: boolean; error?: string }> {
  const args: string[] = ['--json', '--no-ignore', '--max-filesize', String(MAX_FILE_KB_FOR_SEARCH * 1024)];
  if (parsed.fixedString) args.push('-F', parsed.literalPattern);
  else args.push('--regexp', parsed.regexSource);
  if (parsed.caseInsensitive) args.push('-i');
  if (parsed.wholeWord) args.push('-w');
  if (parsed.multiline) args.push('--multiline', '--multiline-dotall');
  if (parsed.contextLines > 0) args.push('-C', String(parsed.contextLines));
  for (const g of parsed.globIncludes) args.push('-g', g);
  for (const ex of parsed.excludeGlobs) {
    for (const g of excludeRipgrepGlobs(ex)) args.push('-g', g);
  }
  args.push('-m', String(parsed.maxResults));

  const cwd = ctx.workspaceRoot.fsPath;
  const searchPaths = parsed.searchRoots.map((u) => {
    const rel = path.relative(cwd, u.fsPath);
    return rel && !rel.startsWith('..') ? rel : u.fsPath;
  });

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(rgPath, [...args, ...searchPaths], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, fallback: true });
      return;
    }

    const cancelSub = ctx.cancellation.onCancellationRequested(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    });

    let stderr = '';
    const hits: LineHit[] = [];
    const perFileCounts = new Map<string, number>();
    let buf = '';
    let totalMatches = 0;
    let failed = false;

    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });

    child.stdout?.on('data', (chunk) => {
      if (ctx.cancellation.isCancellationRequested) {
        child.kill('SIGTERM');
        return;
      }
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { type: string; data?: any };
          if (msg.type === 'match' && msg.data) {
            const rel = toRelative(ctx.workspaceRoot, vscode.Uri.file(path.resolve(cwd, msg.data.path.text)));
            const ln = msg.data.line_number as number;
            const text = String(msg.data.lines?.text ?? '').replace(/\r?\n$/, '');
            hits.push({ rel, line: ln, text: text.trim().slice(0, 200) });
            perFileCounts.set(rel, (perFileCounts.get(rel) || 0) + 1);
            totalMatches++;
            if (totalMatches >= parsed.maxResults) child.kill('SIGTERM');
          } else if (msg.type === 'context' && msg.data && parsed.contextLines > 0) {
            const rel = toRelative(ctx.workspaceRoot, vscode.Uri.file(path.resolve(cwd, msg.data.path.text)));
            const ln = msg.data.line_number as number;
            const text = String(msg.data.lines?.text ?? '').replace(/\r?\n$/, '');
            hits.push({ rel, line: ln, text: text.trim().slice(0, 200), context: true });
          }
        } catch {
          failed = true;
        }
      }
    });

    child.on('error', () => {
      cancelSub.dispose();
      resolve({ ok: false, fallback: true });
    });

    child.on('close', (code) => {
      cancelSub.dispose();
      if (ctx.cancellation.isCancellationRequested) {
        resolve({ ok: true, hits, perFileCounts });
        return;
      }
      if (failed) {
        resolve({ ok: false, fallback: true });
        return;
      }
      if (code !== 0 && code !== null && code !== 1 && stderr.trim()) {
        // Includes rg regex-syntax errors: the pattern already compiled as a JS RegExp (bad ones are rejected in buildPattern),
        // so features rg lacks (look-around, backreferences) are served by the JS scan instead of failing.
        resolve({ ok: false, fallback: true });
        return;
      }
      resolve({ ok: true, hits, perFileCounts });
    });
  });
}

async function runJsScan(
  parsed: ParsedSearch,
  ctx: ToolExecContext,
): Promise<{ hits: LineHit[]; perFileCounts: Map<string, number> }> {
  const hits: LineHit[] = [];
  const perFileCounts = new Map<string, number>();
  const excludePattern = `**/{${parsed.excludeGlobs.join(',')}}/**`;

  let files: vscode.Uri[];
  if (parsed.singleFileRel) {
    files = parsed.searchRoots;
  } else {
    const glob = parsed.globIncludes.length === 1 ? parsed.globIncludes[0] : '**/*';
    files = await vscode.workspace.findFiles(glob, excludePattern, MAX_FILES_SCANNED);
    files = files.filter((uri) => {
      const rel = toRelative(ctx.workspaceRoot, uri);
      if (isExcludedRel(rel, parsed.excludeGlobs)) return false;
      if (parsed.globIncludes.length > 1 && !parsed.globIncludes.some((g) => globToRegExp(g).test(rel))) return false;
      return fileUnderSearchRoots(uri, parsed.searchRoots);
    });
  }

  outer: for (const uri of files) {
    if (ctx.cancellation.isCancellationRequested) break;
    if (looksBinary(uri.fsPath)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (bytes.byteLength > MAX_FILE_KB_FOR_SEARCH * 1024) continue;
    const text = Buffer.from(bytes).toString('utf8');
    const rel = toRelative(ctx.workspaceRoot, uri);
    const lines = text.split('\n');

    if (parsed.multiline) {
      const re = new RegExp(parsed.regex.source, parsed.regex.flags.replace(/g/g, '') + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const before = text.slice(0, m.index);
        const line = before.split('\n').length;
        const lineText = lines[line - 1] ?? '';
        hits.push({ rel, line, text: lineText.trim().slice(0, 200) });
        perFileCounts.set(rel, (perFileCounts.get(rel) || 0) + 1);
        if (countMatchHits(hits) >= parsed.maxResults) break outer;
      }
      continue;
    }

    let fileHasMatch = false;
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(parsed.regex.source, parsed.regex.flags.includes('g') ? parsed.regex.flags : parsed.regex.flags + 'g');
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        if (parsed.contextLines > 0) {
          const from = Math.max(0, i - parsed.contextLines);
          const to = Math.min(lines.length - 1, i + parsed.contextLines);
          for (let j = from; j <= to; j++) {
            const dup = hits.findIndex((h) => h.rel === rel && h.line === j + 1);
            if (dup >= 0) {
              if (j === i) hits[dup].context = false; // a context line that is itself a match becomes a match line
              continue;
            }
            hits.push({ rel, line: j + 1, text: lines[j].trim().slice(0, 200), context: j !== i });
          }
        } else {
          hits.push({ rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
        perFileCounts.set(rel, (perFileCounts.get(rel) || 0) + 1);
        fileHasMatch = true;
        if (countMatchHits(hits) >= parsed.maxResults) break outer;
      }
    }
    void fileHasMatch;
  }

  return { hits, perFileCounts };
}

function formatSearchResult(
  parsed: ParsedSearch,
  hits: LineHit[],
  perFileCounts: Map<string, number> | undefined,
  ctx: ToolExecContext,
): ToolResult {
  const matchHits = hits.filter((h) => !h.context);
  const counts = perFileCounts || new Map<string, number>();

  if (parsed.mode === 'extract') {
    return formatExtractResult(parsed, matchHits, ctx);
  }

  if (matchHits.length === 0) {
    const globPattern = parsed.globIncludes[0] || '**/*';
    const scopeNote = parsed.singleFileRel
      ? parsed.singleFileRel
      : `up to ${MAX_FILES_SCANNED} files under ${globPattern}`;
    return {
      ok: true,
      content: `No matches for "${parsed.query}" (searched ${scopeNote}).`,
    };
  }

  if (parsed.mode === 'files') {
    const files = [...new Set(matchHits.map((h) => h.rel))].sort();
    return { ok: true, content: `${files.length} file(s) matching "${parsed.query}":\n${files.join('\n')}` };
  }

  if (parsed.mode === 'count') {
    const lines = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([f, c]) => `${f}: ${c}`);
    const total = matchHits.length;
    return {
      ok: true,
      content: `${total} match(es) in ${lines.length} file(s) for "${parsed.query}":\n${lines.join('\n')}`,
    };
  }

  const filesWithMatches = new Set(matchHits.map((h) => h.rel)).size;
  const body = hits.map((h) => `${h.rel}:${h.line}: ${h.text}`).join('\n');
  const truncatedNote = matchHits.length >= parsed.maxResults ? `\n... truncated at ${parsed.maxResults} matches, narrow your query` : '';
  return {
    ok: true,
    content: `${matchHits.length} match(es) in ${filesWithMatches} file(s) for "${parsed.query}":\n${body}${truncatedNote}`,
  };
}

function formatExtractResult(parsed: ParsedSearch, matchHits: LineHit[], ctx: ToolExecContext): ToolResult {
  if (!parsed.singleFileRel) {
    return { ok: false, content: 'search_code mode "extract" requires a single file path.' };
  }
  const uri = resolveWorkspacePath(ctx.workspaceRoot, parsed.singleFileRel);
  const text = fs.readFileSync(uri.fsPath, 'utf8');
  const lines = text.split('\n');
  const ext = path.extname(parsed.singleFileRel).toLowerCase();
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const h of matchHits) {
    const key = `${h.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const range = ext === '.md' ? expandMarkdownBlock(lines, h.line - 1) : expandCodeBlock(lines, h.line - 1);
    const slice = clampBlock(range, parsed.maxExtractLines);
    const numbered = slice.lines.map((ln, i) => `${slice.start + i + 1}: ${ln}`).join('\n');
    blocks.push(`--- match at ${parsed.singleFileRel}:${h.line} ---\n${numbered}`);
  }

  if (blocks.length === 0) {
    return { ok: true, content: `No matches for "${parsed.query}" in ${parsed.singleFileRel}.` };
  }
  return { ok: true, content: `${blocks.length} block(s) in ${parsed.singleFileRel} for "${parsed.query}":\n\n${blocks.join('\n\n')}` };
}

function expandCodeBlock(lines: string[], matchLine: number): { start: number; end: number; lines: string[] } {
  const line = lines[matchLine] ?? '';
  const indent = leadingWhitespace(line).length;
  let start = matchLine;
  while (start > 0) {
    const prev = lines[start - 1];
    if (prev.trim() === '') {
      start--;
      continue;
    }
    const prevIndent = leadingWhitespace(prev).length;
    if (prevIndent < indent && /^(def |class |function |export |async function |interface |type )/.test(prev.trim())) {
      start--;
      break;
    }
    if (prevIndent < indent) break;
    start--;
  }
  let end = matchLine;
  while (end + 1 < lines.length) {
    const next = lines[end + 1];
    if (next.trim() === '') {
      end++;
      continue;
    }
    const nextIndent = leadingWhitespace(next).length;
    if (nextIndent <= indent && end > matchLine) {
      if (nextIndent === indent && /^[)}\]]+[;,]?$/.test(next.trim())) end++; // closing brace of the block
      break;
    }
    end++;
  }
  return { start, end, lines: lines.slice(start, end + 1) };
}

function expandMarkdownBlock(lines: string[], matchLine: number): { start: number; end: number; lines: string[] } {
  let level = 0;
  let start = matchLine;
  for (let i = matchLine; i >= 0; i--) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m) {
      level = m[1].length;
      start = i;
      break;
    }
  }
  if (level === 0) return expandCodeBlock(lines, matchLine);
  let end = matchLine;
  for (let i = matchLine + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    end = i;
  }
  return { start, end, lines: lines.slice(start, end + 1) };
}

function fileUnderSearchRoots(uri: vscode.Uri, roots: vscode.Uri[]): boolean {
  for (const root of roots) {
    if (uri.fsPath === root.fsPath) return true;
    const rel = path.relative(root.fsPath, uri.fsPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function countMatchHits(hits: LineHit[]): number {
  return hits.filter((h) => !h.context).length;
}

function excludeRipgrepGlobs(ex: string): string[] {
  if (ex.includes('*') || ex.includes('/')) return [`!${ex}`];
  return [`!${ex}`, `!**/${ex}`, `!${ex}/**`, `!**/${ex}/**`];
}

function isExcludedRel(rel: string, excludeGlobs: string[]): boolean {
  for (const ex of excludeGlobs) {
    if (ex.includes('*') || ex.includes('/')) {
      if (globToRegExp(ex).test(rel)) return true;
      continue;
    }
    if (rel === ex || rel.endsWith('/' + ex) || rel.split('/').includes(ex)) return true;
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          re += '(?:.*/)?';
          i++;
        } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const j = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = j;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$');
}

function clampBlock(range: { start: number; end: number; lines: string[] }, maxLines: number) {
  if (range.lines.length <= maxLines) return range;
  return { start: range.start, end: range.start + maxLines - 1, lines: range.lines.slice(0, maxLines) };
}

function leadingWhitespace(s: string): string {
  const m = /^(\s*)/.exec(s);
  return m ? m[1] : '';
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = v === undefined || v === null || v === '' ? dflt : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function searchCodebaseTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const queryCheck = requireStringArg('search_codebase', 'query', args.query, 'Missing required arg "query".');
  if (!queryCheck.ok) return { ok: false, content: queryCheck.content };
  const query = queryCheck.value;
  const k = clampInt(args.k ? Number(args.k) : 8, 8, 1, 20);

  const results = await ctx.codebaseSearch(query, k);
  if (results.length === 0) {
    return { ok: true, content: `No relevant results found for "${query}". Try search_code for exact string/regex matches instead.` };
  }
  const body = results
    .map((r, i) => `[${i + 1}] ${r.path} (score ${r.score.toFixed(2)})\n${r.snippet}`)
    .join('\n\n');
  return { ok: true, content: `Top ${results.length} relevant chunk(s) for "${query}":\n\n${body}` };
}
