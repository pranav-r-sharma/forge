import * as vscode from 'vscode';
import { spawn } from 'child_process';

const DEFAULT_MAX_OUTPUT_CHARS = 4000;

export interface ShellProcessTreeResult {
  ok: boolean;
  output: string;
}

export interface ShellProcessTreeOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  cancellation?: vscode.CancellationToken;
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
  formatOutput: (params: {
    command: string;
    code: number | null;
    signal: string | null;
    output: string;
    truncated: boolean;
    killedNote: string;
  }) => string;
}

/**
 * Runs a shell command in a detached process group (POSIX) with SIGTERM→SIGKILL
 * tree kill on timeout or cancellation — same escalation as run_command in commandTool.ts.
 */
export function runShellProcessTree(opts: ShellProcessTreeOptions): Promise<ShellProcessTreeResult> {
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 300_000;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const posix = process.platform !== 'win32';

  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let killedByUser = false;
    let escalated = false;
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      detached: posix,
      env: opts.env ?? { ...process.env, CI: '1', FORGE_AGENT: '1' },
    });

    const killTree = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (posix && typeof child.pid === 'number') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* noop */
        }
      }
    };

    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const beginKill = () => {
      if (settled || escalated) return;
      escalated = true;
      killTree('SIGTERM');
      escalationTimer = setTimeout(() => {
        if (!settled) killTree('SIGKILL');
      }, 2000);
    };

    const timeoutTimer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        beginKill();
      }
    }, timeoutMs);

    const onData = (buf: Buffer) => {
      if (output.length < maxOutputChars) output += buf.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const cancelListener = opts.cancellation?.onCancellationRequested(() => {
      if (!settled) {
        killedByUser = true;
        beginKill();
      }
    });

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
    };

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      cancelListener?.dispose();
      resolve({
        ok: false,
        output: opts.formatOutput({
          command: opts.command,
          code: null,
          signal: null,
          output: `Failed to run command: ${err?.message || err}`,
          truncated: false,
          killedNote: '',
        }),
      });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      cancelListener?.dispose();
      const truncated = output.length >= maxOutputChars;
      let killedNote = '';
      if (timedOut) {
        killedNote = `\n(command was terminated — hit the ${timeoutMs}ms timeout${signal === 'SIGKILL' ? ' and had to be force-killed after ignoring the initial stop signal' : ''})`;
      } else if (killedByUser) {
        killedNote = `\n(command was terminated — Stop was requested${signal === 'SIGKILL' ? ' and it had to be force-killed after ignoring the initial stop signal' : ''})`;
      } else if (signal) {
        killedNote = `\n(command received signal ${signal})`;
      }
      resolve({
        ok: code === 0,
        output: opts.formatOutput({
          command: opts.command,
          code,
          signal,
          output: output.trim() || '(no output)',
          truncated,
          killedNote,
        }),
      });
    });
  });
}
