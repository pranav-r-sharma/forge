import * as vscode from 'vscode';
import { LlmProvider } from './llm/provider';
import { providerEndpoint } from './llm/factory';
import { getConfig } from './util/config';

/**
 * A single status bar item showing the current chat model and Ollama
 * connection health; clicking it opens the model picker.
 */
export class ForgeStatusBar {
  private item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private ollama: LlmProvider, context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'forge.selectChatModel';
    context.subscriptions.push(this.item);
    this.item.show();
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 30_000);
    context.subscriptions.push({ dispose: () => this.timer && clearInterval(this.timer) });
  }

  async refresh() {
    const cfg = getConfig();
    const ep = providerEndpoint(cfg);
    const health = await this.ollama.health();
    if (!health.ok) {
      this.item.text = `$(circle-slash) Forge: ${ep.id === 'ollama' ? 'Ollama' : ep.id === 'mlx' ? 'MLX' : 'server'} offline`;
      this.item.tooltip = `Can't reach ${ep.label} at ${ep.baseUrl}: ${health.error}\nClick to configure a model once it's running.`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      return;
    }
    this.item.backgroundColor = undefined;
    const modelLabel = cfg.chatModel || 'no model selected';
    this.item.text = `$(sparkle) Forge: ${modelLabel}`;
    this.item.tooltip = `${ep.label} connected at ${ep.baseUrl}\nChat model: ${cfg.chatModel || '(none)'}\nCompletion model: ${cfg.completionModel || '(uses chat model)'}\nContext window: ${cfg.numCtx.toLocaleString()} tokens · keep-alive: ${cfg.keepAliveMinutes === -1 ? 'forever' : cfg.keepAliveMinutes === 0 ? 'server default' : `${cfg.keepAliveMinutes}m`}\nClick to change model. Run "Forge: Show HW Utilization" for live VRAM/loaded-model info.`;
  }
}
