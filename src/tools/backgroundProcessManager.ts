import { spawn } from 'child_process';

// Not imported as a named type: the sandboxed dev build's type shim
// (_devtools/shim.d.ts) doesn't export ChildProcess from its minimal
// child_process stand-in (only spawn/exec/execFile, typed loosely) since it
// exists solely to let tsc structurally check this project without network
// access to the real @types/node. ReturnType<typeof spawn> resolves
// correctly either way — the real ChildProcess type on a normal machine
// with the real @types/node installed, and `any` under the shim.
type SpawnedProcess = ReturnType<typeof spawn>;

const MAX_OUTPUT_CHARS = 100_000;
/** Hard cap on simultaneously-running background processes, per workspace — a safety bound so a confused model can't spawn an unbounded pile of dev servers/watchers it then forgets about. Killing one (check_background_command with action "kill") frees a slot. */
const MAX_CONCURRENT = 5;

export interface BackgroundProcessSummary {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  startedAt: string;
}

interface BackgroundProcessRecord extends BackgroundProcessSummary {
  child: SpawnedProcess;
  output: string;
  truncated: boolean;
}

let counter = 0;

/**
 * Item "ability to interact and use the terminal and run commands via the
 * terminal" (the agent-facing half — see commands.ts's openTerminalCommand
 * for the user-facing half, a real integrated terminal). run_command's hard
 * timeout (commandTool.ts's MAX_TIMEOUT_MS) is the right behavior for
 * build/test/lint commands that are SUPPOSED to finish — but wrong for
 * anything that's supposed to keep running: a dev server, a file watcher, a
 * long migration you want to poll. Before this, the only options were "wait
 * up to 3 minutes then get killed" or "don't use run_command for this at
 * all." This lets the model start such a command in the background, get an
 * id back immediately, and poll its output/status across as many further
 * tool calls as it needs — even in a LATER turn, since the process outlives
 * any single runAgentTurn() call — exactly like a person running
 * `npm run dev &` in a real terminal and checking back on it later.
 *
 * Workspace-scoped and shared across every open chat tab (constructed once
 * in extension.ts and threaded through ChatSessionServices, the same way
 * PendingEditManager is), not per-session — a background process is a real
 * OS process tied to the one real workspace, not conversation state, so any
 * tab (or a fresh chat) can see and manage the same dev server, same as a
 * real terminal would.
 */
export class BackgroundProcessManager {
  private processes = new Map<string, BackgroundProcessRecord>();

  private runningCount(): number {
    let n = 0;
    for (const p of this.processes.values()) if (p.status === 'running') n++;
    return n;
  }

  start(command: string, cwd: string): { ok: true; id: string } | { ok: false; error: string } {
    if (this.runningCount() >= MAX_CONCURRENT) {
      return {
        ok: false,
        error: `Refused: ${MAX_CONCURRENT} background commands are already running in this workspace. Check/kill an existing one (check_background_command with action "kill", or "list") before starting another.`,
      };
    }
    counter += 1;
    const id = `bg_${Date.now().toString(36)}_${counter}`;
    let child: SpawnedProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        env: { ...process.env, CI: '1', FORGE_AGENT: '1' },
        // `detached: true` on POSIX makes this child the leader of its own
        // process group (pgid === its own pid), which is what makes kill()
        // below able to actually stop it — see that method's doc comment
        // for why plain child.kill() isn't enough for a shell command.
        detached: process.platform !== 'win32',
      });
    } catch (err: any) {
      return { ok: false, error: `Failed to start: ${err?.message || err}` };
    }
    const record: BackgroundProcessRecord = {
      id,
      command,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      child,
      output: '',
      truncated: false,
    };
    const onData = (buf: Buffer) => {
      if (record.output.length < MAX_OUTPUT_CHARS) record.output += buf.toString('utf8');
      else record.truncated = true;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', (code: number | null) => {
      record.status = 'exited';
      record.exitCode = code;
    });
    child.on('error', (err: any) => {
      record.status = 'exited';
      record.exitCode = null;
      record.output += `\n[Failed to run: ${err.message}]`;
    });
    this.processes.set(id, record);
    return { ok: true, id };
  }

  /** Current output/status snapshot — output accumulates from the process's start, not since the last check, so re-checking always shows the full picture (capped at MAX_OUTPUT_CHARS, oldest-kept — see `truncated`). */
  check(id: string): { found: false } | { found: true; status: 'running' | 'exited'; exitCode: number | null; output: string; command: string; truncated: boolean } {
    const record = this.processes.get(id);
    if (!record) return { found: false };
    return { found: true, status: record.status, exitCode: record.exitCode, output: record.output, command: record.command, truncated: record.truncated };
  }

  kill(id: string): { found: false } | { found: true; alreadyExited: boolean } {
    const record = this.processes.get(id);
    if (!record) return { found: false };
    if (record.status === 'exited') return { found: true, alreadyExited: true };
    this.killTree(record.child);
    return { found: true, alreadyExited: false };
  }

  /**
   * `child.kill()` alone only signals the immediate spawned process — with
   * `{shell: true}` that's the shell (`sh -c "<command>"`), not necessarily
   * the actual command it runs. Depending on the shell, that command can be
   * a genuine child of the shell rather than an exec()-replacement of it,
   * in which case killing just the shell leaves the real work (a dev
   * server, `sleep`, whatever) running orphaned and undetectable — exactly
   * the kind of leak this whole feature exists to avoid. Killing the
   * negative pid instead signals the entire process GROUP (requires the
   * `detached: true` at spawn time above, which makes this child its own
   * group leader), which reaches the shell and everything it started.
   * Windows has no process-group signaling story to speak of, so this
   * falls back to a plain kill() there — a known, narrower guarantee on
   * that platform, consistent with this codebase's other honestly-documented
   * Windows gaps (see README's known limitations).
   */
  private killTree(child: SpawnedProcess) {
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        process.kill(-child.pid, 'SIGTERM');
        return;
      }
    } catch {
      /* process group may already be gone, or platform doesn't support it — fall through to the plain kill below */
    }
    try {
      child.kill();
    } catch {
      /* best-effort */
    }
  }

  list(): BackgroundProcessSummary[] {
    return [...this.processes.values()].map(({ id, command, cwd, status, exitCode, startedAt }) => ({ id, command, cwd, status, exitCode, startedAt }));
  }

  /** Called on extension deactivate — kills every still-running background process rather than leaving orphaned dev servers/watchers behind when the extension host shuts down or reloads. */
  disposeAll() {
    for (const record of this.processes.values()) {
      if (record.status === 'running') this.killTree(record.child);
    }
  }
}
