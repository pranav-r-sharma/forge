import { ToolExecContext, ToolResult } from '../agent/types';

/**
 * Thin tool wrappers around ToolExecContext.taskLedger — the actual
 * TaskLedger mutation/persistence/report-writing lives in ChatSession (see
 * agent/taskLedger.ts's doc comment for the full "mandatory checkpoint
 * progress" rationale), exactly the same split as spawn_subagent's
 * ctx.spawnSubAgent vs. its own thin wrapper in subAgentTool.ts.
 */

export async function planTasksTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const raw = args?.tasks;
  const tasks: string[] = Array.isArray(raw) ? raw.filter((t) => typeof t === 'string' && t.trim()) : typeof raw === 'string' && raw.trim() ? [raw] : [];
  if (tasks.length === 0) {
    return { ok: false, content: 'plan_tasks requires a non-empty "tasks" array of short task descriptions (one string per task).' };
  }
  const parentTaskId = typeof args?.parentTaskId === 'string' ? args.parentTaskId : undefined;
  const ids = ctx.taskLedger.addTasks(tasks, parentTaskId);
  const lines = tasks.map((t, i) => `- [${ids[i]}] ${t}`).join('\n');
  return {
    ok: true,
    content: `Recorded ${tasks.length} task(s) in the ledger:\n${lines}\n\nEach one starts "pending". Work through them — for a task you delegate, spawn_subagent already marks its own ledger entry automatically; for anything you do yourself, call update_task to mark it "in_progress" before starting and "done"/"failed" (with a short summary) once it's resolved, so a resumed session never redoes finished work.`,
  };
}

export async function updateTaskTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const id = typeof args?.id === 'string' ? args.id.trim() : '';
  const status = args?.status;
  if (!id) return { ok: false, content: 'update_task requires "id" — the task id returned by plan_tasks (or list the ledger by calling update_task with an unknown id to see the error listing current ones).' };
  if (status !== 'in_progress' && status !== 'done' && status !== 'failed') {
    return { ok: false, content: 'update_task requires "status" to be one of "in_progress", "done", or "failed".' };
  }
  const summary = typeof args?.summary === 'string' ? args.summary : undefined;
  const applied = ctx.taskLedger.updateTask(id, status, summary);
  if (!applied) {
    const known = ctx.taskLedger.list();
    const listing = known.length ? known.map((t) => `- [${t.id}] (${t.status}) ${t.description}`).join('\n') : '(the ledger is currently empty — call plan_tasks first)';
    return { ok: false, content: `No task with id "${id}" in the ledger. Current tasks:\n${listing}` };
  }
  return { ok: true, content: `Task "${id}" marked ${status}${summary ? `: ${summary}` : '.'}` };
}
