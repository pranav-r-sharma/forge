import * as vscode from 'vscode';
import { ToolExecContext, ToolResult } from '../agent/types';
import { requireStringArg } from './argErrors';
import { isIgnoredDir, looksBinary, toRelative } from '../util/paths';

const MAX_FILES_SCANNED = 10_000;
const MAX_MATCHES = 200;
const MAX_FILE_KB_FOR_SEARCH = 8192;

export async function searchCodeTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const queryCheck = requireStringArg(
    'search_code',
    'query',
    args.query ?? args.pattern,
    'Missing required arg "query".',
  );
  if (!queryCheck.ok) return { ok: false, content: queryCheck.content };
  const query = queryCheck.value;
  const globPattern: string = args.glob || '**/*';

  let regex: RegExp;
  const slashMatch = /^\/(.*)\/([a-z]*)$/i.exec(query);
  try {
    regex = slashMatch ? new RegExp(slashMatch[1], slashMatch[2].includes('i') ? 'i' : '') : new RegExp(escapeRegExp(query), 'i');
  } catch {
    regex = new RegExp(escapeRegExp(query), 'i');
  }

  const excludePattern = '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target}/**';
  let files: vscode.Uri[];
  try {
    files = await vscode.workspace.findFiles(globPattern, excludePattern, MAX_FILES_SCANNED);
  } catch (err: any) {
    return { ok: false, content: `search_code failed: ${err.message || err}` };
  }

  const matches: string[] = [];
  let filesWithMatches = 0;
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
    if (!regex.test(text)) continue;
    const rel = toRelative(ctx.workspaceRoot, uri);
    const lines = text.split('\n');
    let fileHasMatch = false;
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        fileHasMatch = true;
        if (matches.length >= MAX_MATCHES) break outer;
      }
    }
    if (fileHasMatch) filesWithMatches++;
  }

  if (matches.length === 0) {
    return { ok: true, content: `No matches for "${query}" (searched up to ${MAX_FILES_SCANNED} files under ${globPattern}).` };
  }
  const truncatedNote = matches.length >= MAX_MATCHES ? `\n... truncated at ${MAX_MATCHES} matches, narrow your query` : '';
  return {
    ok: true,
    content: `${matches.length} match(es) in ${filesWithMatches} file(s) for "${query}":\n${matches.join('\n')}${truncatedNote}`,
  };
}

export async function searchCodebaseTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const queryCheck = requireStringArg('search_codebase', 'query', args.query, 'Missing required arg "query".');
  if (!queryCheck.ok) return { ok: false, content: queryCheck.content };
  const query = queryCheck.value;
  const k = clamp(args.k ? Number(args.k) : 8, 1, 20);

  const results = await ctx.codebaseSearch(query, k);
  if (results.length === 0) {
    return { ok: true, content: `No relevant results found for "${query}". Try search_code for exact string/regex matches instead.` };
  }
  const body = results
    .map((r, i) => `[${i + 1}] ${r.path} (score ${r.score.toFixed(2)})\n${r.snippet}`)
    .join('\n\n');
  return { ok: true, content: `Top ${results.length} relevant chunk(s) for "${query}":\n\n${body}` };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
