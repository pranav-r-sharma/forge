import { ToolExecContext, ToolResult } from '../agent/types';

/**
 * Companion to run_command's {"background": true} — see
 * tools/backgroundProcessManager.ts for the underlying process tracking.
 * Three actions in one tool (rather than three separate tools) because they
 * share the same "which background command" framing and the model only
 * ever needs one of them at a time:
 *   - {"id"} or {"id","action":"status"} — output/status so far.
 *   - {"id","action":"kill"} — stop it.
 *   - {"action":"list"} (no id needed) — every background command started
 *     this session, running or exited, for when the model has lost track of
 *     an id (e.g. after a compaction pass summarized it away).
 */
export async function checkBackgroundCommandTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action : 'status';

  if (action === 'list') {
    const all = ctx.listBackgroundCommands();
    if (all.length === 0) return { ok: true, content: 'No background commands have been started this session.' };
    const lines = all.map((p) => `- ${p.id} [${p.status}${p.status === 'exited' ? `, exit ${p.exitCode ?? 'unknown'}` : ''}]: ${p.command}`);
    return { ok: true, content: lines.join('\n') };
  }

  const id: string = args.id ?? '';
  if (!id || typeof id !== 'string') {
    return { ok: false, content: 'Missing required arg "id" (the id returned when the background command was started). Use {"action": "list"} to see every id if you\'ve lost track of it.' };
  }

  if (action === 'kill') {
    const result = ctx.killBackgroundCommand(id);
    if (!result.found) return { ok: false, content: `No background command with id "${id}" — it may have never existed, or use {"action": "list"} to see current ids.` };
    if (result.alreadyExited) return { ok: true, content: `"${id}" had already exited — nothing to kill.` };
    return { ok: true, content: `Killed "${id}".` };
  }

  if (action !== 'status') {
    return { ok: false, content: `Unknown action "${action}". Use "status" (default), "kill", or "list".` };
  }

  const result = ctx.checkBackgroundCommand(id);
  if (!result.found) {
    return { ok: false, content: `No background command with id "${id}" — it may have never existed, or use {"action": "list"} to see current ids.` };
  }
  const truncatedNote = result.truncated ? '\n... output truncated (still running/producing more than this tool keeps)' : '';
  const header = `$ ${result.command}\n(status: ${result.status}${result.status === 'exited' ? `, exit code: ${result.exitCode ?? 'unknown'}` : ' — still running'})`;
  return {
    ok: result.status !== 'exited' || result.exitCode === 0,
    content: `${header}\n${result.output.trim() || '(no output yet)'}${truncatedNote}`,
  };
}
