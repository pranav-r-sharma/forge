import * as vscode from 'vscode';
import { OllamaClient, keepAliveOpt } from '../ollama/client';
import { getConfig } from '../util/config';
import { buildFimContext, cleanCompletion } from './fimPrompt';
import { logger } from '../util/logger';

const STOP_SEQUENCES = ['\n\n\n', '<|endoftext|>', '<|fim_pad|>'];

/**
 * Ghost-text Tab autocomplete, backed by a local Ollama FIM-capable model.
 * Debounces so we don't fire a generation request on every keystroke, and
 * cancels stale requests as soon as a newer one supersedes them.
 */
export class ForgeInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private ollama: OllamaClient) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig();
    if (!cfg.enableTabCompletion) return undefined;
    const model = cfg.completionModel || cfg.chatModel;
    if (!model) return undefined;

    const myGeneration = ++this.generation;
    const debounceMs = Math.max(0, cfg.completionDebounceMs);

    const proceed = await new Promise<boolean>((resolve) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => resolve(true), debounceMs);
      token.onCancellationRequested(() => resolve(false));
    });
    if (!proceed || token.isCancellationRequested || myGeneration !== this.generation) return undefined;

    const { prefix, suffix } = buildFimContext(document, position);
    if (!prefix.trim() && !suffix.trim()) return undefined;

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    let raw: string;
    try {
      raw = await this.ollama.generate({
        model,
        prompt: prefix,
        suffix,
        temperature: 0.1,
        maxTokens: 128,
        stop: STOP_SEQUENCES,
        signal: controller.signal,
        numCtx: cfg.numCtx,
        keepAliveMinutes: keepAliveOpt(cfg.keepAliveMinutes),
      });
    } catch (err: any) {
      if (err?.name !== 'AbortError') logger.warn('inline completion generate() failed', String(err));
      return undefined;
    }

    if (token.isCancellationRequested || myGeneration !== this.generation) return undefined;

    const cleaned = cleanCompletion(raw, suffix);
    if (!cleaned || !cleaned.trim()) return undefined;

    return [new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))];
  }
}
