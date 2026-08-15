import * as vscode from 'vscode';
import { PendingEditManager } from './editApply';

export const FORGE_DIFF_SCHEME = 'forge-diff';

/**
 * Serves the "before" and "after" text of a pending edit as virtual
 * read-only documents so we can open a real VS Code diff editor
 * (`vscode.diff`) for edits that haven't been written to disk yet.
 * URI shape: forge-diff:/<editId>/original|proposed/<relativePath basename for a nice tab title>
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private edits: PendingEditManager) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parts = uri.path.split('/').filter(Boolean);
    const [id, side] = parts;
    const edit = this.edits.get(id);
    if (!edit) return '';
    return side === 'original' ? edit.originalText : edit.newText;
  }

  static uriFor(editId: string, side: 'original' | 'proposed', basename: string): vscode.Uri {
    return vscode.Uri.parse(`${FORGE_DIFF_SCHEME}:/${editId}/${side}/${basename}`);
  }
}

export async function openDiffForEdit(edits: PendingEditManager, id: string) {
  const edit = edits.get(id);
  if (!edit) {
    vscode.window.showWarningMessage('That proposed edit is no longer pending (it may have already been accepted or rejected).');
    return;
  }
  const basename = edit.relativePath.split('/').pop() || edit.relativePath;
  const original = DiffContentProvider.uriFor(id, 'original', basename);
  const proposed = DiffContentProvider.uriFor(id, 'proposed', basename);
  const title = `${edit.relativePath} (Forge proposed change)`;
  await vscode.commands.executeCommand('vscode.diff', original, proposed, title, { preview: true });
}
