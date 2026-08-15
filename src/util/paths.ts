import * as path from 'path';
import * as vscode from 'vscode';

export class PathOutsideWorkspaceError extends Error {
  constructor(p: string) {
    super(`Refusing to touch a path outside the workspace: ${p}`);
  }
}

/**
 * Resolves a (possibly model-supplied) relative path against the workspace
 * root and guarantees the result cannot escape the workspace via `..` — the
 * agent's file tools must never read/write outside the open folder.
 */
export function resolveWorkspacePath(workspaceRoot: vscode.Uri, relPath: string): vscode.Uri {
  const cleaned = (relPath || '.').replace(/^\/+/, '').replace(/^\.\/+/, '');
  const rootFs = workspaceRoot.fsPath;
  const joined = path.normalize(path.join(rootFs, cleaned));
  const rel = path.relative(rootFs, joined);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathOutsideWorkspaceError(relPath);
  }
  return vscode.Uri.joinPath(workspaceRoot, cleaned === '.' ? '' : cleaned);
}

export function toRelative(workspaceRoot: vscode.Uri, uri: vscode.Uri): string {
  const rel = path.relative(workspaceRoot.fsPath, uri.fsPath);
  return rel.split(path.sep).join('/');
}

const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', '.venv', 'venv',
  '__pycache__', '.cache', 'coverage', '.turbo', '.parcel-cache', 'target',
  '.forge-index',
]);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name) || name.startsWith('.');
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.pdf', '.zip',
  '.tar', '.gz', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.eot', '.mp4',
  '.mp3', '.wav', '.mov', '.avi', '.exe', '.dll', '.so', '.dylib', '.class',
  '.jar', '.wasm', '.db', '.sqlite', '.node',
]);

export function looksBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
