import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecContext, ToolResult } from '../agent/types';
import { requireStringArg, suggestCommandFromArgvArray } from './argErrors';
import { resolveWorkspacePath } from '../util/paths';

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

let callCounter = 0;

export type CwdResolution = { ok: true; cwd: string; note?: string } | { ok: false; error: string };

/**
 * Resolves run_command's optional `cwd` against the workspace root and CHECKS it exists before spawning. Found by the full-suite run: a model passed
 * the workspace's own NAME as `cwd` ("t05-large-file"), Node answered `spawn /bin/sh ENOENT` — which says nothing about a missing folder — and the
 * model retried the identical call five times. Now: an existing folder is used; the workspace's own name is understood as the root (with a note);
 * anything else gets an error that says what is wrong and lists the real folders. Throws only via resolveWorkspacePath (path escapes the workspace).
 */
export function resolveCommandCwd(
  workspaceRootFsPath: string,
  requested: unknown,
  deps: { isDir?: (p: string) => boolean; list?: (p: string) => string[] } = {}
): CwdResolution {
  const isDir = deps.isDir ?? ((p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  const list = deps.list ?? ((p: string) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== '__pycache__').map((d) => d.name).sort(); } catch { return []; } });
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw || raw === '.' || raw === './') return { ok: true, cwd: workspaceRootFsPath };
  const target = resolveWorkspacePath(vscode.Uri.file(workspaceRootFsPath), raw).fsPath;
  if (isDir(target)) return { ok: true, cwd: target };
  const rootName = path.basename(workspaceRootFsPath);
  if (raw.replace(/\/+$/, '') === rootName) {
    return { ok: true, cwd: workspaceRootFsPath, note: `Note: there is no folder "${rootName}" inside the workspace — that is the workspace itself, so the command ran in the workspace root. Commands run there by default; omit "cwd" unless you need a subfolder.` };
  }
  const dirs = list(workspaceRootFsPath).slice(0, 15);
  return { ok: false, error: `The "cwd" folder "${raw}" does not exist under the workspace root. Commands run from the workspace root by default, so omit "cwd" unless you need a subfolder.${dirs.length ? ` Folders in the workspace root: ${dirs.map((d) => d + '/').join(', ')}.` : ''}` };
}

export async function runCommandTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const commandCheck = requireStringArg(
    'run_command',
    'command',
    args.command,
    'Missing required arg "command" (a shell command string).',
    (wrong) => (Array.isArray(wrong) ? suggestCommandFromArgvArray(wrong) : undefined),
  );
  if (!commandCheck.ok) return { ok: false, content: commandCheck.content };
  const command = commandCheck.value;

  callCounter += 1;
  const callId = `cmd_${Date.now().toString(36)}_${callCounter}`;

  const approved = await ctx.requestCommandApproval(command, callId, ctx.workspaceRoot.fsPath);
  if (!approved) {
    return { ok: false, content: 'The user did not approve running this command. Ask before proceeding, or try a different approach.' };
  }

  let cwd: string;
  let cwdNote: string | undefined;
  try {
    const r = resolveCommandCwd(ctx.workspaceRoot.fsPath, args.cwd);
    if (!r.ok) return { ok: false, content: r.error };
    cwd = r.cwd;
    cwdNote = r.note;
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

  // Item "stop button freezes the chat" (also covers: a command that hits its
  // own configured timeout but ignores SIGTERM): both the built-in
  // spawn({timeout}) option and a bare child.kill() only ever signal the
  // immediate child process. When that child is itself a shell running a
  // pipeline/subprocess (the common case, since we always spawn with
  // shell:true), the grandchildren can easily outlive it and keep the
  // process's stdio pipes open — which means `close` never fires and this
  // tool call's promise never resolves, wedging the whole turn (and, upstream
  // in agentLoop.ts's raceToolCallWithCancellation, only papered over with a
  // fake "aborted" result after a grace period — the process itself would
  // still be running). Fix: spawn detached (POSIX: its own process group) so
  // we can signal the whole tree via the negative-pid convention, and
  // self-manage the timeout so both "hit configured timeout" and "user
  // clicked Stop" go through the same SIGTERM-then-SIGKILL escalation.
  const posix = process.platform !== 'win32';

  return new Promise<ToolResult>((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let killedByUser = false;
    let escalated = false;
    const child = spawn(command, {
      shell: true,
      cwd,
      detached: posix,
      env: { ...process.env, CI: '1', FORGE_AGENT: '1' },
    });

    // Not typed as NodeJS.Signals: the sandboxed dev build's type shim
    // (_devtools/shim.d.ts) doesn't declare the NodeJS namespace at all
    // (same reason backgroundProcessManager.ts's SpawnedProcess avoids
    // ChildProcess — see its doc comment), and the real @types/node type is
    // structurally just a string literal union anyway. Only these two
    // signals are ever actually sent here.
    const killTree = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (posix && typeof child.pid === 'number') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Process (or process group) may already be gone — nothing to do.
        try { child.kill(signal); } catch { /* noop */ }
      }
    };

    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const beginKill = () => {
      if (settled || escalated) return;
      escalated = true;
      killTree('SIGTERM');
      // Grace period for a well-behaved process to exit on SIGTERM before we
      // escalate — this is the actual fix for "ignores SIGTERM and hangs
      // forever": previously there was nothing beyond the single signal.
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
      if (output.length < MAX_OUTPUT_CHARS) output += buf.toString('utf8');
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const cancelListener = ctx.cancellation.onCancellationRequested(() => {
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
      cancelListener.dispose();
      resolve({ ok: false, content: `Failed to run command: ${err.message}${err.code === 'ENOENT' ? ` (the shell could not be started in ${cwd} — check that the folder exists)` : ''}` });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      cancelListener.dispose();
      const truncated = output.length >= MAX_OUTPUT_CHARS ? '\n... output truncated' : '';
      let killedNote = '';
      if (timedOut) {
        killedNote = `\n(command was terminated — hit the ${timeoutMs}ms timeout${signal === 'SIGKILL' ? ' and had to be force-killed after ignoring the initial stop signal' : ''})`;
      } else if (killedByUser) {
        killedNote = `\n(command was terminated — Stop was requested${signal === 'SIGKILL' ? ' and it had to be force-killed after ignoring the initial stop signal' : ''})`;
      } else if (signal) {
        killedNote = `\n(command received signal ${signal})`;
      }
      const header = `$ ${command}\n(exit code: ${code ?? 'unknown'}${signal ? `, signal: ${signal}` : ''})`;
      resolve({
        ok: code === 0,
        content: `${header}\n${output.trim() || '(no output)'}${truncated}${killedNote}${cwdNote ? `\n\n${cwdNote}` : ''}`,
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

export function isDangerousCommand(command: string, workspaceRootFsPath?: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command)) || isWorkspaceWipe(command, workspaceRootFsPath);
}

/**
 * True when `command` is an `rm -r -f`-style recursive delete whose target resolves to the agent's own
 * workspace root, an ancestor of it, or the bare current directory (`.`/`./`). Found by the
 * t07-build-from-scratch acceptance test (see PROGRESS.md): stuck on a self-misdiagnosed test failure,
 * the model ran `rm -rf "<absolute workspace path>"` to "start over" — DANGEROUS_COMMAND_PATTERNS above
 * only guards `rm -rf /` and `rm -rf ~` (wiping the whole disk/home), not this far more likely case of
 * an agent deleting its own project directory, after which every subsequent run_command call fails with
 * no way to recover. Deliberately narrow: only recursive-delete-of-the-workspace-root is caught, not
 * every risky delete inside it, which the agent is trusted to manage like any other edit. `workspaceRootFsPath`
 * is optional so this degrades to "not flagged" (never blocks) when no workspace context is available,
 * rather than guessing.
 */
export function isWorkspaceWipe(command: string, workspaceRootFsPath?: string): boolean {
  if (!workspaceRootFsPath) return false;
  const root = path.resolve(workspaceRootFsPath);
  return command.split(/&&|\|\||;|\|/).some((segment) => segmentWipesRoot(segment, root, workspaceRootFsPath));
}

function segmentWipesRoot(segment: string, root: string, workspaceRootFsPath: string): boolean {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const rmIdx = tokens.findIndex((t) => /(^|\/)rm$/.test(t));
  if (rmIdx === -1) return false;
  let hasR = false;
  let hasF = false;
  const targets: string[] = [];
  for (const raw of tokens.slice(rmIdx + 1)) {
    const tok = raw.replace(/^["']|["']$/g, '');
    if (tok === '--recursive') { hasR = true; continue; }
    if (tok === '--force') { hasF = true; continue; }
    if (/^-[a-zA-Z]+$/.test(tok)) {
      if (/[rR]/.test(tok)) hasR = true;
      if (/f/.test(tok)) hasF = true;
      continue;
    }
    targets.push(tok);
  }
  if (!hasR || !hasF || targets.length === 0) return false;
  return targets.some((t) => {
    if (t === '.' || t === './') return true;
    const resolved = path.isAbsolute(t) ? path.resolve(t) : path.resolve(workspaceRootFsPath, t);
    return resolved === root || root.startsWith(resolved + path.sep);
  });
}
