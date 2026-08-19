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

  // Item "ability to interact and use the terminal and run commands via the
  // terminal": {"background": true} skips the spawn-and-wait-for-exit
  // behavior below entirely — this is for anything that's SUPPOSED to keep
  // running (a dev server, a watcher), which the fixed timeout below would
  // otherwise just kill partway through startup. See
  // tools/backgroundProcessManager.ts and the check_background_command tool
  // for how the model gets output/status back afterward.
  if (args.background === true) {
    const started = ctx.startBackgroundCommand(command, cwd);
    if (!started.ok) return { ok: false, content: started.error };
    return {
      ok: true,
      content: `Started in the background as "${started.id}". It keeps running independently of this turn — use check_background_command with {"id": "${started.id}"} to see its output/status so far, or {"id": "${started.id}", "action": "kill"} to stop it.`,
    };
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

/**
 * A small, hard-coded denylist of commands that stay gated behind human
 * approval no matter what — including in Auto mode ("no human in the loop"),
 * which otherwise skips approval entirely. This is a deliberate, narrow
 * exception: Auto mode trusts the agent to recover from ordinary mistakes on
 * its own, but a handful of actions are destructive enough (wipe the disk,
 * force-push over the main branch, fork-bomb the machine) that "the agent
 * will just figure it out" isn't an acceptable risk to take unattended.
 * Everything else in Auto mode really does run with zero approval.
 */
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|\/\*|~\/?\s*$|~\/\*)/i, // rm -rf / or ~
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // classic shell fork bomb
  /mkfs(\.\w+)?\s+/i,
  />\s*\/dev\/(sd|nvme|hd|disk)/i,
  /dd\s+[^\n]*\bof=\/dev\//i,
  /git\s+push\s+(-f|--force)\S*\s+\S*\s*(origin\s+)?(main|master)\b/i,
  /chmod\s+-R\s+777\s+\/(\s|$)/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /diskutil\s+(erase|reformat|partitiondisk)/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}
