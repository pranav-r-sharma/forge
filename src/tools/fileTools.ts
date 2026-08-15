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

  if (hasSearchReplace) {
    if (existing === undefined) {
      return { ok: false, content: `Cannot search/replace in "${relPath}": file does not exist. Use "content" to create it.` };
    }
    const search: string = args.search;
    const occurrences = countOccurrences(existing, search);
    if (occurrences === 0) {
      return {
        ok: false,
        content: `The "search" text was not found in ${relPath}. It must match the file's current content exactly (whitespace included, no line-number gutters). Re-read the file and try a smaller, unique snippet.`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        content: `The "search" text matches ${occurrences} places in ${relPath}, which is ambiguous. Include more surrounding context so it uniquely identifies one location.`,
      };
    }
    newText = existing.replace(search, () => args.replace);
    kind = 'modify';
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

  const { id, applied } = await ctx.proposeEdit(
    { uri, relativePath: relPath, originalText: existing ?? '', newText, kind },
    );

  const verb = kind === 'create' ? 'Created' : 'Updated';
  const verbPending = kind === 'create' ? 'creating' : 'updating';
  return {
    ok: true,
    content: applied
      ? `${verb} ${relPath}.`
      : `Proposed ${verbPending} ${relPath} — awaiting your review in the chat panel (edit id ${id}). You may continue working; this file's content for you is now the proposed version.`,
  };
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
