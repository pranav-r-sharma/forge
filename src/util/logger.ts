import * as vscode from 'vscode';

/** Thin wrapper around a single shared OutputChannel ("Forge") for diagnostics. */
class Logger {
  private channel: vscode.OutputChannel | undefined;

  init(context: vscode.ExtensionContext) {
    this.channel = vscode.window.createOutputChannel('Forge');
    context.subscriptions.push(this.channel);
  }

  private ts() {
    return new Date().toISOString().split('T')[1].replace('Z', '');
  }

  info(msg: string, ...rest: any[]) {
    const line = `[${this.ts()}] ${msg} ${rest.length ? JSON.stringify(rest) : ''}`.trim();
    this.channel?.appendLine(line);
  }

  warn(msg: string, ...rest: any[]) {
    this.info(`WARN: ${msg}`, ...rest);
  }

  error(msg: string, err?: unknown) {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
    this.channel?.appendLine(`[${this.ts()}] ERROR: ${msg} ${detail}`);
  }

  show() {
    this.channel?.show(true);
  }
}

export const logger = new Logger();
