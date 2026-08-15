import * as vscode from 'vscode';
import { looksBinary, toRelative } from '../util/paths';

/**
 * Zero-setup fallback for @codebase / search_codebase when no embedding
 * model is installed: scores files by how many distinct query terms they
 * contain (crude TF, but fast, dependency-free, and good enough to surface
 * "which files mention X and Y" style questions).
 */
export async function keywordCodebaseSearch(
  workspaceRoot: vscode.Uri,
  query: string,
  k: number
): Promise<{ path: string; snippet: string; score: number }[]> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const files = await vscode.workspace.findFiles(
    '**/*',
    '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target}/**',
    4000
  );

  const scored: { path: string; snippet: string; score: number }[] = [];
  for (const uri of files) {
    if (looksBinary(uri.fsPath)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (bytes.byteLength > 300 * 1024) continue;
    const text = Buffer.from(bytes).toString('utf8');
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const count = countOccurrences(lower, term);
      if (count > 0) score += Math.min(count, 5);
    }
    if (score === 0) continue;

    // Grab a snippet around the first matching term for context.
    const firstTerm = terms.find((t) => lower.includes(t));
    let snippet = text.slice(0, 400);
    if (firstTerm) {
      const idx = lower.indexOf(firstTerm);
      const start = Math.max(0, idx - 150);
      const end = Math.min(text.length, idx + 250);
      snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }
    scored.push({ path: toRelative(workspaceRoot, uri), snippet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function countOccurrences(haystack: string, needle: string): number {
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
