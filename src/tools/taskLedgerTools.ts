import { ToolExecContext, ToolResult } from '../agent/types';
import { CostTier, estimateCostHeuristic, isCostTier, renderPlanCostLine, renderPlanCostWarning, renderPlanReviewDetail, summarizePlanCost } from '../agent/taskCost';
import { genId } from '../util/ids';

/**
 * Thin tool wrappers around ToolExecContext.taskLedger — the actual
 * TaskLedger mutation/persistence/report-writing lives in ChatSession (see
 * agent/taskLedger.ts's doc comment for the full "mandatory checkpoint
 * progress" rationale), exactly the same split as spawn_subagent's
 * ctx.spawnSubAgent vs. its own thin wrapper in subAgentTool.ts.
 */

interface ParsedTask {
  description: string;
  costTier?: CostTier;
  costNote?: string;
}

/** Accepts either a bare string (backward-compatible with pre-0.13.0 calls, and with a model that hasn't picked up the cost-tier convention yet) or `{description, costTier?, costNote?}` per entry. Anything else is dropped rather than erroring the whole call — one malformed entry in an otherwise-fine array shouldn't sink the rest of the plan. */
function parseTasks(raw: any): ParsedTask[] {
  const arr: any[] = Array.isArray(raw) ? raw : typeof raw === 'string' || (raw && typeof raw === 'object') ? [raw] : [];
  const out: ParsedTask[] = [];
  for (const t of arr) {
    if (typeof t === 'string') {
      if (t.trim()) out.push({ description: t.trim() });
    } else if (t && typeof t === 'object' && typeof t.description === 'string' && t.description.trim()) {
      out.push({
        description: t.description.trim(),
        costTier: isCostTier(t.costTier) ? t.costTier : undefined,
        costNote: typeof t.costNote === 'string' && t.costNote.trim() ? t.costNote.trim() : undefined,
      });
    }
  }
  return out;
}

export async function planTasksTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const tasks = parseTasks(args?.tasks);
  if (tasks.length === 0) {
    return {
      ok: false,
      content:
        'plan_tasks requires a non-empty "tasks" array — each entry either a short description string, or {"description", "costTier": "cheap"|"moderate"|"expensive", "costNote"?} to also record a cost estimate (recommended — see the tool description for what each tier means).',
    };
  }
  const parentTaskId = typeof args?.parentTaskId === 'string' ? args.parentTaskId : undefined;

  // Cost-aware task planning (forge.taskLedger.costAwarePlanning, default
  // on): estimate every task's cost BEFORE committing anything to the
  // ledger, so a plan that's about to take a long time can be caught before
  // dispatch starts, not discovered partway through — see agent/taskCost.ts.
  // When the setting is off, this whole block is skipped and plan_tasks
  // behaves exactly as it did before this feature existed.
  if (!ctx.config.costAwarePlanningEnabled) {
    const ids = ctx.taskLedger.addTasks(tasks.map((t) => t.description), parentTaskId);
    const lines = tasks.map((t, i) => `- [${ids[i]}] ${t.description}`).join('\n');
    return {
      ok: true,
      content: `Recorded ${tasks.length} task(s) in the ledger:\n${lines}\n\nEach one starts "pending". For a task you delegate, spawn_subagent already marks its own ledger entry automatically; for anything you do yourself, call update_task to mark it "in_progress" before starting and "done"/"failed" (with a short summary) once it's resolved, so a resumed session never redoes finished work.`,
    };
  }

  const withCost = tasks.map((t) => ({
    description: t.description,
    costTier: t.costTier || estimateCostHeuristic(t.description),
    costNote: t.costNote,
  }));
  const summary = summarizePlanCost(withCost);
  const overThreshold = summary.score >= ctx.config.expensivePlanReviewThreshold;

  if (overThreshold && !ctx.config.isAutonomousMode && ctx.config.reviewExpensivePlansEnabled) {
    const callId = genId('planreview');
    const detail = renderPlanReviewDetail(withCost, summary, ctx.config.expensivePlanReviewThreshold);
    const approved = await ctx.requestPlanApproval(detail, callId);
    if (!approved) {
      return {
        ok: false,
        content: `The user did not approve starting this plan as estimated (${renderPlanCostLine(summary)}). Nothing was added to the task ledger. Revise the plan — break the expensive task(s) into smaller/cheaper pieces, drop what isn't actually needed, or ask the user what they'd rather do — before calling plan_tasks again.`,
      };
    }
  }

  const ids = ctx.taskLedger.addTasks(withCost, parentTaskId);
  const lines = withCost.map((t, i) => `- [${ids[i]}] (${t.costTier}) ${t.description}`).join('\n');
  const orderingNote = summary.expensive + summary.moderate > 0 ? ' Where there is no dependency reason to do otherwise, work through the cheap tasks first — it fails fast and preserves the most progress if this session gets interrupted partway through.' : '';
  // Non-blocking counterpart of the review gate above: an autonomous mode
  // (Auto/Outcome) or reviewExpensivePlans:false means nothing paused, but
  // the user still gets told — see ToolResult.warning's doc comment.
  const warning = overThreshold && (ctx.config.isAutonomousMode || !ctx.config.reviewExpensivePlansEnabled)
    ? renderPlanCostWarning(summary, ctx.config.expensivePlanReviewThreshold, ctx.config.isAutonomousMode ? 'an autonomous (Auto/Outcome)' : 'this')
    : undefined;

  return {
    ok: true,
    content: `Recorded ${withCost.length} task(s) in the ledger — estimated cost: ${renderPlanCostLine(summary)}.\n${lines}\n\nEach one starts "pending".${orderingNote} For a task you delegate, spawn_subagent already marks its own ledger entry automatically; for anything you do yourself, call update_task to mark it "in_progress" before starting and "done"/"failed" (with a short summary) once it's resolved, so a resumed session never redoes finished work.`,
    warning,
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
