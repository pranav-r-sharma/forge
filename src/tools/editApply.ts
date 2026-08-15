import * as vscode from 'vscode';
import { PendingEdit, PendingEditSerialized } from '../agent/types';
import { unifiedDiff } from '../util/diff';
import { toRelative } from '../util/paths';
import { logger } from '../util/logger';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `edit_${Date.now().toString(36)}_${counter}`;
}

/**
 * Owns every file edit the agent has proposed in the current session.
 *
 * Design: proposed edits are NOT written to disk immediately. Instead they
 * live in an in-memory overlay keyed by workspace-relative path, so that
 * `read_file` / subsequent `write_file` calls within the same agent turn see
 * the *proposed* content (letting the model make several dependent edits to
 * one file without waiting on the human). The overlay is only flushed to
 * disk when the user accepts — either per-file or via "Accept All" — from
 * the chat panel's review cards. Rejecting simply drops the overlay entry.
 *
 * When `requireApprovalForWrites` is off, edits are written through
 * immediately and reported as already-applied.
 */
export class PendingEditManager {
  private pending = new Map<string, PendingEdit>();
  /** relativePath -> latest pending edit id for that path (edits supersede each other). */
  private byPath = new Map<string, string>();

  private readonly _onDidChange = new vscode.EventEmitter<PendingEditSerialized[]>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private workspaceRoot: vscode.Uri) {}

  private fire() {
    this._onDidChange.fire(this.listSerialized());
  }

  /** Returns the effective (overlay-aware) content for a file, or undefined if it doesn't exist anywhere. */
  async readEffective(uri: vscode.Uri): Promise<string | undefined> {
    const rel = toRelative(this.workspaceRoot, uri);
    const pendingId = this.byPath.get(rel);
    if (pendingId) {
      const edit = this.pending.get(pendingId);
      if (edit) return edit.kind === 'delete' ? undefined : edit.newText;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  /**
   * Registers a proposed edit. If approval is not required it is written to
   * disk immediately (and the overlay is cleared for that path); otherwise it
   * is staged and surfaced to the chat UI for review.
   */
  async propose(edit: Omit<PendingEdit, 'id'>, requireApproval: boolean): Promise<{ id: string; applied: boolean }> {
    const id = nextId();
    const full: PendingEdit = { ...edit, id };
    const rel = full.relativePath;

    if (!requireApproval) {
      await this.writeToDisk(full);
      return { id, applied: true };
    }

    // A new proposal for a path supersedes any earlier still-pending one.
    const priorId = this.byPath.get(rel);
    if (priorId) this.pending.delete(priorId);
    this.pending.set(id, full);
    this.byPath.set(rel, id);
    this.fire();
    return { id, applied: false };
  }

  private async writeToDisk(edit: PendingEdit): Promise<void> {
    if (edit.kind === 'delete') {
      try {
        await vscode.workspace.fs.delete(edit.uri);
      } catch (err) {
        logger.warn('Failed to delete file', edit.relativePath, String(err));
      }
      return;
    }
    const dir = vscode.Uri.joinPath(edit.uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      /* already exists */
    }
    await vscode.workspace.fs.writeFile(edit.uri, Buffer.from(edit.newText, 'utf8'));
  }

  async accept(id: string): Promise<boolean> {
    const edit = this.pending.get(id);
    if (!edit) return false;
    await this.writeToDisk(edit);
    this.pending.delete(id);
    if (this.byPath.get(edit.relativePath) === id) this.byPath.delete(edit.relativePath);
    this.fire();
    return true;
  }

  reject(id: string): boolean {
    const edit = this.pending.get(id);
    if (!edit) return false;
    this.pending.delete(id);
    if (this.byPath.get(edit.relativePath) === id) this.byPath.delete(edit.relativePath);
    this.fire();
    return true;
  }

  async acceptAll(): Promise<number> {
    const ids = [...this.pending.keys()];
    for (const id of ids) await this.accept(id);
    return ids.length;
  }

  rejectAll(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.reject(id);
    return ids.length;
  }

  get(id: string): PendingEdit | undefined {
    return this.pending.get(id);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  listSerialized(): PendingEditSerialized[] {
    return [...this.pending.values()].map(serialize);
  }
}

export function serialize(edit: PendingEdit): PendingEditSerialized {
  const { text, additions, deletions } = unifiedDiff(edit.originalText, edit.newText);
  return {
    id: edit.id,
    relativePath: edit.relativePath,
    kind: edit.kind,
    diffPreview: text,
    additions,
    deletions,
  };
}
