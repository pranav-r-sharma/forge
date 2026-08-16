import * as vscode from 'vscode';
import { toRelative } from './paths';

export interface FileSearchEntry {
  path: string;
  kind: 'file' | 'folder';
}

/**
 * Backs the `@`-mention dropdown (item "folders and files both can be
 * tagged"). Folders are derived from the same cached file listing (every
 * unique ancestor directory of every matched file) rather than a separate,
 * more expensive directory walk — cheap, and in practice covers every real
 * folder in the workspace since every non-empty folder contains at least
 * one file somewhere under it.
 */
export class WorkspaceEntryIndex {
  private cache: { at: number; files: string[]; folders: string[] } | undefined;
  private readonly ttlMs = 15_000;

  constructor(private workspaceRoot: vscode.Uri) {}

  invalidate() {
    this.cache = undefined;
  }

  private async ensureFresh(): Promise<{ files: string[]; folders: string[] }> {
    const now = Date.now();
    if (this.cache && now - this.cache.at <= this.ttlMs) return this.cache;
    const uris = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target,.forge}/**',
      8000
    );
    const files = uris.map((u) => toRelative(this.workspaceRoot, u)).sort();
    const folderSet = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) folderSet.add(parts.slice(0, i).join('/'));
    }
    const folders = [...folderSet].sort();
    this.cache = { at: now, files, folders };
    return this.cache;
  }

  async query(q: string, limit = 30): Promise<FileSearchEntry[]> {
    const { files, folders } = await this.ensureFresh();
    const needle = q.toLowerCase();
    const matchedFolders = (needle ? folders.filter((f) => f.toLowerCase().includes(needle)) : folders.slice(0, 10)).slice(0, 8);
    const matchedFiles = (needle ? files.filter((f) => f.toLowerCase().includes(needle)) : files).slice(0, limit);
    const results: FileSearchEntry[] = [
      ...matchedFolders.map((path): FileSearchEntry => ({ path, kind: 'folder' })),
      ...matchedFiles.map((path): FileSearchEntry => ({ path, kind: 'file' })),
    ];
    return results.slice(0, limit);
  }
}
