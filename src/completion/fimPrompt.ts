import * as vscode from 'vscode';

const MAX_PREFIX_CHARS = 6000;
const MAX_SUFFIX_CHARS = 3000;

export interface FimContext {
  prefix: string;
  suffix: string;
}

/**
 * Builds the prefix/suffix pair for fill-in-middle completion. We deliberately
 * send raw code (no chat wrapper) via Ollama's /api/generate `prompt` +
 * `suffix` fields and let Ollama apply the model's own FIM template — this
 * keeps us correct across qwen2.5-coder, deepseek-coder, starcoder2,
 * codegemma, codellama, etc. without hand-maintaining each model's special
 * tokens. Models without a FIM template just ignore `suffix` and continue
 * from the prefix, which still degrades gracefully to a useful completion.
 */
export function buildFimContext(document: vscode.TextDocument, position: vscode.Position): FimContext {
  const fullPrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
  const fullSuffix = document.getText(new vscode.Range(position, document.positionAt(document.getText().length)));

  const prefix = fullPrefix.length > MAX_PREFIX_CHARS ? fullPrefix.slice(fullPrefix.length - MAX_PREFIX_CHARS) : fullPrefix;
  const suffix = fullSuffix.length > MAX_SUFFIX_CHARS ? fullSuffix.slice(0, MAX_SUFFIX_CHARS) : fullSuffix;

  return { prefix, suffix };
}

/**
 * Cleans a raw FIM completion: strips accidental markdown fences, trims
 * anything after the model starts re-typing the existing suffix (a common
 * artifact when a model doesn't fully respect the FIM boundary), and drops
 * empty/no-op results.
 */
export function cleanCompletion(raw: string, suffix: string): string {
  let text = raw;

  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)```\s*$/.exec(text.trim());
  if (fence) text = fence[1];

  // If the model echoes back a chunk of the suffix, cut there — it's re-typing code that already exists.
  const suffixStart = suffix.slice(0, 40).trim();
  if (suffixStart.length > 8) {
    const idx = text.indexOf(suffixStart);
    if (idx > 0) text = text.slice(0, idx);
  }

  // Guard against runaway completions (a model that ignores stop sequences).
  const lines = text.split('\n');
  if (lines.length > 60) text = lines.slice(0, 60).join('\n');

  return text;
}
