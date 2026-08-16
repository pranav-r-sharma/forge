import * as vscode from 'vscode';
import { OllamaClient, keepAliveOpt } from '../ollama/client';
import { getConfig } from '../util/config';
import { unifiedDiff } from '../util/diff';
import { logger } from '../util/logger';

interface ActiveEdit {
  editor: vscode.TextEditor;
  range: vscode.Range; // current range occupied by the *new* text
  originalText: string;
  newText: string;
  addedDecoration: vscode.TextEditorDecorationType;
  hintDecoration: vscode.TextEditorDecorationType;
}

/**
 * Implements the Cmd+K "edit selection with AI" flow: prompts for an
 * instruction, sends the selection (plus a little surrounding context) to
 * the model, applies the replacement directly into the buffer, and highlights
 * it so the user can accept (Cmd+Enter) or reject/undo (Cmd+Backspace) — the
 * same rhythm as Cursor's inline edit, implemented with VS Code decorations
 * rather than a custom floating widget.
 */
export class InlineEditController {
  private active: ActiveEdit | undefined;

  constructor(private ollama: OllamaClient, private context: vscode.ExtensionContext) {}

  private setActiveContext(value: boolean) {
    vscode.commands.executeCommand('setContext', 'forge.inlineEditActive', value);
  }

  async trigger(editor: vscode.TextEditor) {
    if (this.active) {
      await this.accept(); // implicitly accept whatever was pending before starting a new one
    }

    const cfg = getConfig();
    if (!cfg.chatModel) {
      vscode.window.showErrorMessage('Forge: no chat model selected yet. Open the Forge sidebar to pick one.');
      return;
    }

    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const doc = editor.document;

    const instruction = await vscode.window.showInputBox({
      title: hasSelection ? 'Forge: Edit selection' : 'Forge: Generate code here',
      placeHolder: hasSelection
        ? 'Describe the change, e.g. "add null checks and early return"'
        : 'Describe what to insert, e.g. "a debounce helper function"',
      prompt: `${doc.uri.path.split('/').pop()} — ${hasSelection ? `lines ${selection.start.line + 1}-${selection.end.line + 1}` : `line ${selection.active.line + 1}`}`,
    });
    if (!instruction) return;

    const originalText = doc.getText(hasSelection ? selection : new vscode.Range(selection.active, selection.active));
    const contextBefore = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, selection.start.line - 40), 0), selection.start));
    const contextAfter = doc.getText(
      new vscode.Range(selection.end, new vscode.Position(Math.min(doc.lineCount - 1, selection.end.line + 40), 0))
    );

    const prompt = buildInlineEditPrompt({
      languageId: doc.languageId,
      fileName: vscode.workspace.asRelativePath(doc.uri),
      instruction,
      contextBefore,
      selected: originalText,
      contextAfter,
      hasSelection,
    });

    let raw = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Forge is editing…', cancellable: true },
      async (_progress, token) => {
        try {
          raw = await this.ollama.chat({
            model: cfg.chatModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: Math.min(cfg.temperature, 0.3),
            signal: tokenToSignal(token),
            numCtx: cfg.numCtx,
            keepAliveMinutes: keepAliveOpt(cfg.keepAliveMinutes),
          });
        } catch (err: any) {
          // Same fix as the chat panel's Stop button (item #8): a user
          // cancelling this progress notification aborts the fetch, which
          // shouldn't be reported as a connectivity failure.
          if (err?.name === 'AbortError') return;
          logger.error('inline edit chat() failed', err);
          vscode.window.showErrorMessage(`Forge inline edit failed: ${err?.message || err}`);
        }
      }
    );
    if (!raw) return;

    const newText = extractCode(raw, originalText);
    if (newText.trim() === originalText.trim()) {
      vscode.window.showInformationMessage('Forge: model returned no changes.');
      return;
    }

    const editRange = hasSelection ? selection : new vscode.Range(selection.active, selection.active);
    const applied = await editor.edit((builder: any) => {
      builder.replace(editRange, newText);
    });
    if (!applied) {
      vscode.window.showErrorMessage('Forge: failed to apply the edit.');
      return;
    }

    const startPos = editRange.start;
    const endPos = doc.positionAt(doc.offsetAt(startPos) + newText.length);
    const newRange = new vscode.Range(startPos, endPos);

    const { additions, deletions } = unifiedDiff(originalText, newText);
    const addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      isWholeLine: false,
    });
    const hintDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: `  Forge: +${additions} -${deletions}  ·  ⌘Enter accept  ·  ⌘⌫ reject`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 1em',
      },
    });

    editor.setDecorations(addedDecoration, [newRange]);
    editor.setDecorations(hintDecoration, [new vscode.Range(newRange.end, newRange.end)]);

    this.active = { editor, range: newRange, originalText, newText, addedDecoration, hintDecoration };
    this.setActiveContext(true);
  }

  async accept() {
    if (!this.active) return;
    this.clearDecorations();
    this.active = undefined;
    this.setActiveContext(false);
  }

  async reject() {
    const a = this.active;
    if (!a) return;
    this.clearDecorations();
    await a.editor.edit((builder: any) => {
      builder.replace(a.range, a.originalText);
    });
    this.active = undefined;
    this.setActiveContext(false);
  }

  private clearDecorations() {
    if (!this.active) return;
    this.active.editor.setDecorations(this.active.addedDecoration, []);
    this.active.editor.setDecorations(this.active.hintDecoration, []);
    this.active.addedDecoration.dispose();
    this.active.hintDecoration.dispose();
  }
}

function buildInlineEditPrompt(opts: {
  languageId: string;
  fileName: string;
  instruction: string;
  contextBefore: string;
  selected: string;
  contextAfter: string;
  hasSelection: boolean;
}): string {
  const task = opts.hasSelection
    ? `Rewrite ONLY the "SELECTED CODE" block below per the instruction. Keep it consistent with the surrounding context and the file's existing style.`
    : `Write code to insert exactly at the "INSERT HERE" cursor position below, per the instruction. Keep it consistent with the surrounding context and the file's existing style.`;

  return `You are an expert ${opts.languageId} programmer editing ${opts.fileName}.

${task}

Respond with ONLY the replacement code — no explanations, no markdown code fences, no commentary. Just the raw code that should go in place of the selection (or at the cursor).

Instruction: ${opts.instruction}

CONTEXT BEFORE:
${opts.contextBefore}
${opts.hasSelection ? '----- SELECTED CODE START -----' : '----- INSERT HERE -----'}
${opts.selected}
${opts.hasSelection ? '----- SELECTED CODE END -----' : ''}
CONTEXT AFTER:
${opts.contextAfter}`;
}

/** Strips a possible ```lang fence wrapper the model may add despite instructions not to. */
function extractCode(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenceMatch) return fenceMatch[1];
  return trimmed || fallback;
}

function tokenToSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
