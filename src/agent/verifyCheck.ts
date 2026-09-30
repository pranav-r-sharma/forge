import * as vscode from 'vscode';
import { runShellProcessTree } from '../util/shellProcessTree';

const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface VerifyCheckResult {
  ok: boolean;
  output: string;
}

/**
 * Runs the user-configured "definition of done" command (Auto/Outcome
 * modes — see ChatSession.verifyCommand) and reports whether it exited 0.
 * Deliberately separate from `commandTool.ts`'s `runCommandTool`: this is a
 * command the *user* typed in ahead of time to describe what "done" means,
 * not one the model is choosing to run right now, so it doesn't go through
 * ApprovalBroker — the user already consented to it running automatically
 * when they set it. Still respects cancellation (stopping a turn stops this
 * too) and is capped the same way run_command is, so a hung dev server
 * can't wedge the turn forever.
 */
export function runVerifyCommand(
  command: string,
  cwd: string,
  cancellation: vscode.CancellationToken,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerifyCheckResult> {
  const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return runShellProcessTree({
    command,
    cwd,
    timeoutMs: timeout,
    cancellation,
    maxOutputChars: MAX_OUTPUT_CHARS,
    formatOutput: ({ command: cmd, code, output, truncated, killedNote }) => {
      const trunc = truncated ? '\n... output truncated' : '';
      return `$ ${cmd}\n(exit code: ${code ?? 'unknown'})\n${output}${trunc}${killedNote}`;
    },
  });
}
