/**
 * Cost-aware task planning — an extension of the 0.12.0 mandatory task-ledger
 * framework (see agent/taskLedger.ts's doc comment). The request this answers:
 * "on constrained hardware, estimate which tasks are cheap vs. expensive
 * before committing to the plan, so the orchestrator can order cheap-first
 * (fail fast, preserve partial progress) or flag 'this will take a while,
 * want to review first'." Directly useful precisely because 0.12.0 already
 * establishes that interruption on local/self-hosted hardware is common
 * enough to build infrastructure around — this is one more piece of that
 * same infrastructure, not a separate concern.
 *
 * Split into its own module (rather than folded into taskLedger.ts) so it has
 * no dependency on TaskLedgerEntry/TaskLedger at all — both taskLedger.ts and
 * tools/taskLedgerTools.ts import FROM here, never the other way, so there's
 * no import cycle to reason about.
 */

export type CostTier = 'cheap' | 'moderate' | 'expensive';

export function isCostTier(v: unknown): v is CostTier {
  return v === 'cheap' || v === 'moderate' || v === 'expensive';
}

/**
 * Relative weight used to turn a list of tiers into one aggregate "how big is
 * this plan" number — deliberately not linear (1/2/3), so a single genuinely
 * expensive task (a large refactor, a multi-file migration) can outweigh a
 * handful of cheap ones the way it actually would on real hardware, rather
 * than needing several of them to add up to the same signal.
 */
export const COST_WEIGHTS: Record<CostTier, number> = {
  cheap: 1,
  moderate: 3,
  expensive: 8,
};

// Deliberately narrow, high-precision signals only — the goal is "catch the
// obvious cases for free," not "understand the task." Anything ambiguous
// falls through to 'moderate' (see estimateCostHeuristic below) rather than
// guessing in either direction from a weak match.
const EXPENSIVE_HINTS: RegExp[] = [
  /\brefactor/i,
  /\brewrit(e|ing)\b/i,
  /\bmigrat/i,
  /\boverhaul/i,
  /\brearchitect/i,
  /\bredesign/i,
  /\brework\b/i,
  /\bport (it |this )?to\b/i,
  /\bacross (the|every|all)\b/i,
  /\ball files\b/i,
  /\bevery file\b/i,
  /\bentire (codebase|project|repo|module)\b/i,
  /\bmulti-?file\b/i,
  /\blarge[- ]scale\b/i,
  /\bupgrade (the|all)\b/i,
  /\bconvert (the|this) (whole|entire)\b/i,
];
const CHEAP_HINTS: RegExp[] = [
  /\bread\b/i,
  /\bcheck\b/i,
  /\block at\b/i,
  /\blook at\b/i,
  /\bverify\b/i,
  /\binspect\b/i,
  /\bsmall (edit|fix|change|tweak)\b/i,
  /\btypo\b/i,
  /\brename\b/i,
  /\bone[- ]line\b/i,
  /\bsingle (file|line)\b/i,
  /\btweak\b/i,
  /\bbump\b/i,
  /\badd a comment\b/i,
];

/**
 * Cheap, dependency-free keyword heuristic — the same category of mechanism
 * as gamingDetection.ts's regex scan or the 0.10.0 indentation advisory: not
 * a substitute for real judgment (only the model, which actually knows the
 * codebase and the task's real scope, can estimate that well), but a
 * mandatory, always-available fallback so a ledger entry is never left with
 * no cost tier at all just because the model didn't set one — see
 * TaskLedger.add()'s doc comment for why that "mechanical fallback
 * regardless of model discipline" pattern matters here the same way it does
 * for spawn_subagent's auto-instrumentation. Defaults to 'moderate' — the
 * "genuinely don't know" middle ground — when neither signal fires, rather
 * than silently over- or under-weighting an ambiguous task in either
 * direction.
 */
export function estimateCostHeuristic(description: string): CostTier {
  const text = description.toLowerCase();
  if (EXPENSIVE_HINTS.some((re) => re.test(text))) return 'expensive';
  if (CHEAP_HINTS.some((re) => re.test(text))) return 'cheap';
  return 'moderate';
}

export interface PlanCostSummary {
  cheap: number;
  moderate: number;
  expensive: number;
  /** Weighted aggregate — see COST_WEIGHTS. What review-threshold comparisons are made against. */
  score: number;
  total: number;
}

/** Aggregates a set of cost tiers — used both for "just this plan_tasks call" (the review-gate decision) and "the whole ledger" (nothing currently calls it that way, but nothing stops a future caller from). A missing/undefined tier is treated as 'moderate', matching TaskLedger.add()'s own default when no explicit or heuristic tier is available. */
export function summarizePlanCost(entries: { costTier?: CostTier }[]): PlanCostSummary {
  let cheap = 0;
  let moderate = 0;
  let expensive = 0;
  for (const e of entries) {
    const tier = e.costTier || 'moderate';
    if (tier === 'cheap') cheap++;
    else if (tier === 'expensive') expensive++;
    else moderate++;
  }
  const score = cheap * COST_WEIGHTS.cheap + moderate * COST_WEIGHTS.moderate + expensive * COST_WEIGHTS.expensive;
  return { cheap, moderate, expensive, score, total: entries.length };
}

export function renderPlanCostLine(summary: PlanCostSummary): string {
  const parts: string[] = [];
  if (summary.cheap) parts.push(`${summary.cheap} cheap`);
  if (summary.moderate) parts.push(`${summary.moderate} moderate`);
  if (summary.expensive) parts.push(`${summary.expensive} expensive`);
  return `${parts.join(', ') || 'no tasks'} (weighted cost score: ${summary.score})`;
}

const TIER_TAG: Record<CostTier, string> = { cheap: '[cheap]', moderate: '[moderate]', expensive: '[EXPENSIVE]' };

/**
 * The multi-line text shown in the blocking approval card (see
 * ApprovalBroker.requestPlanApproval / agent/types.ts's ToolExecContext.requestPlanApproval)
 * when a plan's aggregate cost crosses forge.taskLedger.expensivePlanReviewThreshold
 * in a mode that isn't fully autonomous.
 */
export function renderPlanReviewDetail(entries: { description: string; costTier: CostTier; costNote?: string }[], summary: PlanCostSummary, threshold: number): string {
  const lines = entries.map((e, i) => `${i + 1}. ${TIER_TAG[e.costTier]} ${e.description}${e.costNote ? ` — ${e.costNote}` : ''}`);
  return (
    `This plan has ${summary.total} task(s): ${renderPlanCostLine(summary)} — at or above the review threshold (${threshold}).\n\n` +
    `${lines.join('\n')}\n\n` +
    `Approve to let the agent start on this plan (cheapest tasks first is recommended, so an interruption preserves the most finished work), or deny to have it revise the plan — e.g. break the expensive task(s) into smaller pieces — before starting anything.`
  );
}

/**
 * The non-blocking counterpart for a fully autonomous mode (Auto/Outcome) or
 * when forge.taskLedger.reviewExpensivePlans is off — those modes/settings
 * mean "no approval prompts," by explicit prior design (see
 * modes.ts's isAutonomousMode doc comment), so an expensive plan there can't
 * pause the turn the way it does in Agent mode. It can still tell you,
 * though — same "advisory, not a gate" precedent as gamingDetection.ts's
 * verify-bypass warning. Surfaced via ToolResult.warning -> AgentEvent
 * 'tool_warning' -> a visible transcript entry, not just tucked into the
 * tool call's own result text.
 */
export function renderPlanCostWarning(summary: PlanCostSummary, threshold: number, modeLabel: string): string {
  return `This plan (${renderPlanCostLine(summary)}) is at or above the review threshold (${threshold}) and may take a while. Proceeding automatically since this chat is in ${modeLabel} mode, which doesn't pause for approval — you can always restore an earlier checkpoint if you'd rather stop it. Switch to Agent mode (with forge.taskLedger.reviewExpensivePlans on) to get a chance to review a plan like this before it starts, next time.`;
}
