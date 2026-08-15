import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { ToolExecContext, ToolResult } from '../agent/types';
import { resolveWorkspacePath } from '../util/paths';

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

let callCounter = 0;

export async function runCommandTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const command: string = args.command ?? '';
  if (!command || typeof command !== 'string') {
    return { ok: false, content: 'Missing required arg "command" (a shell command string).' };
  }

  callCounter += 1;
  const callId = `cmd_${Date.now().toString(36)}_${callCounter}`;

  const approved = await ctx.requestCommandApproval(command, callId);
  if (!approved) {
    return { ok: false, content: 'The user did not approve running this command. Ask before proceeding, or try a different approach.' };
  }

  let cwd: string;
  try {
    cwd = resolveWorkspacePath(ctx.workspaceRoot, args.cwd || '.').fsPath;
  } catch (err: any) {
    return { ok: false, content: err.message };
  }

  const timeoutMs = Math.min(args.timeout_ms ? Number(args.timeout_ms) : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  return new Promise<ToolResult>((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(command, {
      shell: true,
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, CI: '1', FORGE_AGENT: '1' },
    });

    const onData = (buf: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += buf.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const cancelListener = ctx.cancellation.onCancellationRequested(() => {
      if (!settled) {
        try { child.kill(); } catch { /* noop */ }
      }
    });

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      cancelListener.dispose();
      resolve({ ok: false, content: `Failed to run command: ${err.message}` });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      cancelListener.dispose();
      const truncated = output.length >= MAX_OUTPUT_CHARS ? '\n... output truncated' : '';
      const killedNote = signal === 'SIGTERM' ? `\n(command was terminated — possibly hit the ${timeoutMs}ms timeout)` : '';
      const header = `$ ${command}\n(exit code: ${code ?? 'unknown'}${signal ? `, signal: ${signal}` : ''})`;
      resolve({
        ok: code === 0,
        content: `${header}\n${output.trim() || '(no output)'}${truncated}${killedNote}`,
      });
    });
  });
}

export function commandMatchesAutoApprove(command: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(command.trim());
    } catch {
      return false;
    }
  });
}
