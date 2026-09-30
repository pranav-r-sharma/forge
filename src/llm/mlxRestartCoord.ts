import * as vscode from 'vscode';

let activeAgentTurns = 0;
let mlxRestartPending = false;
let ensureMlxFn: (() => Promise<void>) | null = null;
let statusDisposable: vscode.Disposable | undefined;

/** Registered once from extension activation (the real ensureMlx wrapper). */
export function registerMlxEnsureRunner(fn: () => Promise<void>): void {
  ensureMlxFn = fn;
}

export function notifyAgentTurnStarted(): void {
  activeAgentTurns++;
}

export function notifyAgentTurnEnded(): void {
  activeAgentTurns = Math.max(0, activeAgentTurns - 1);
  if (activeAgentTurns === 0 && mlxRestartPending) {
    mlxRestartPending = false;
    statusDisposable?.dispose();
    statusDisposable = undefined;
    if (ensureMlxFn) void ensureMlxFn().catch(() => undefined);
  }
}

/** For unit tests — reset module state. */
export function resetMlxRestartCoordForTests(): void {
  activeAgentTurns = 0;
  mlxRestartPending = false;
  ensureMlxFn = null;
  statusDisposable?.dispose();
  statusDisposable = undefined;
}

export function isMlxRestartPending(): boolean {
  return mlxRestartPending;
}

export function activeAgentTurnCount(): number {
  return activeAgentTurns;
}

/**
 * MLX settings changed: restart immediately when no turn is in flight, otherwise queue until the last turn ends.
 */
export function requestMlxRestartAfterSettingsChange(): void {
  if (!ensureMlxFn) return;
  if (activeAgentTurns > 0) {
    mlxRestartPending = true;
    statusDisposable?.dispose();
    if (typeof vscode.window.setStatusBarMessage === 'function') {
      statusDisposable = vscode.window.setStatusBarMessage('MLX restart pending until this turn finishes');
    }
    return;
  }
  void ensureMlxFn().catch(() => undefined);
}
