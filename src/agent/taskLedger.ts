import { genId } from '../util/ids';
import { CostTier, estimateCostHeuristic, summarizePlanCost, renderPlanCostLine } from './taskCost';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface TaskLedgerEntry {
  id: string;
  description: string;
  status: TaskStatus;
  /** Set once the task reaches 'done'/'failed' (and sometimes earlier, e.g. a sub-agent's own summary while still running) — the short "what happened" a resuming agent/human reads instead of redoing the work to find out. */
  summary?: string;
  /** Set when this task was created as part of decomposing a bigger parent task (see plan_tasks/spawn_subagent auto-instrumentation) — lets renderTaskLedgerForPrompt() show real hierarchy instead of one flat list. */
  parentTaskId?: string;
  /**
   * Cost-aware task planning: a rough size estimate for this one task —
   * 'cheap' (a single file read or small localized edit), 'moderate' (a few
   * files or a moderately sized change), or 'expensive' (a large refactor,
   * many files, a migration — anything likely to take a long chain of tool
   * calls). Always populated once the entry exists (see add() below) —
   * either the model's own estimate (plan_tasks accepts one per task) or a
   * mechanical keyword-heuristic fallback (agent/taskCost.ts) when it
   * doesn't provide one, the same "mandatory regardless of model
   * discipline" treatment the rest of this ledger already gets. Optional on
   * the TYPE only so old, already-persisted sessions from before this field
   * existed still deserialize cleanly via fromJSON().
   */
  costTier?: CostTier;
  /** Optional one-line reason for the cost estimate above (model-provided only — the heuristic fallback never sets this, it has no explanation to give). */
  costNote?: string;
  /**
   * 0.14.0 checkpoint/task-manifest unification: the id of the checkpoint
   * (agent/checkpoints.ts) active in the turn that most recently touched
   * this entry — set by ChatSession.onTaskLedgerChanged(), which stamps it
   * from whatever checkpoint is current at the moment. This is deliberately
   * the SCOPED-DOWN version of "task-to-checkpoint linkage": it tells you
   * which turn's checkpoint to restoreCheckpoint() to if you want the
   * workspace back to how it looked when this task was last worked on, but
   * it is not a full nested per-task checkpoint system (no separate
   * sub-agent-scoped file snapshots) — that's called out explicitly as
   * future work in CHANGELOG.md rather than attempted here, since the
   * existing per-turn checkpoint already covers the common "undo everything
   * since I started this" case this field exists to point at.
   */
  checkpointId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mandatory checkpoint-progress framework (item 4a/4b: "not enough hardware
 * [so] agents gets interrupted and thus the new agent needs to pick up from
 * the last point rather than do redundant work again" / "create a mandatory
 * log of each individual task"). This is the STRUCTURED half of that fix —
 * see AgentEvent's 'history_snapshot' (agent/types.ts) for the other half,
 * which keeps the raw model-facing transcript itself from going stale.
 *
 * Why a second, structured mechanism on top of a transcript fix: even with
 * modelHistory persisted perfectly up to the moment of interruption, "did I
 * already finish investigating the build failure" is a fact buried
 * somewhere inside a long raw conversation — a resuming agent (or a human
 * skimming what happened) has to re-read the whole thing to reconstruct it.
 * A TaskLedger makes that fact a first-class, O(1)-to-check piece of state:
 * a short list of {description, status, summary} entries, mechanically
 * rendered into every turn's prompt (see renderTaskLedgerForPrompt(), fed
 * into buildTurnContextPrefix() exactly like milestones/memory/project-log
 * already are) so "here's what's already done, don't redo it" is right in
 * front of the model without it having to go looking.
 *
 * Deliberately NOT gated behind the orchestration-mode toggle (see
 * modes.ts / ChatSession.orchestrationEnabled) — "mandatory" per the
 * request means this framework exists and is populated on every session
 * regardless of that toggle: agentLoop.ts auto-records a ledger entry for
 * every spawn_subagent call in ANY mode (see runAgentTurn's taskLedger deps
 * usage), and the plan_tasks/update_task tools are available whenever
 * spawn_subagent is (agent/auto/outcome — see modes.ts's ALL_TOOLS). What
 * the orchestration toggle actually changes is the SYSTEM PROMPT'S
 * instructions on how to use it (decompose up front, spawn sequentially,
 * report and re-plan) — the ledger and its persistence work identically
 * either way.
 *
 * Kept intentionally simple — a flat array with an optional parent pointer,
 * not a full DAG/scheduler — because its only job is "let a human or a
 * resuming agent see progress at a glance," not to actually orchestrate
 * anything itself (agentLoop.ts's normal one-tool-per-round-trip ReAct loop
 * is what actually runs tasks).
 */
export class TaskLedger {
  private entries: TaskLedgerEntry[] = [];

  constructor(initial?: TaskLedgerEntry[]) {
    if (initial) this.entries = initial;
  }

  list(): TaskLedgerEntry[] {
    return this.entries;
  }

  get(id: string): TaskLedgerEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(description: string, parentTaskId?: string, costTier?: CostTier, costNote?: string): TaskLedgerEntry {
    const now = new Date().toISOString();
    const trimmedDescription = description.trim() || '(untitled task)';
    const entry: TaskLedgerEntry = {
      id: genId('task'),
      description: trimmedDescription,
      status: 'pending',
      parentTaskId: parentTaskId && this.get(parentTaskId) ? parentTaskId : undefined,
      // Cost-aware task planning — see the field's own doc comment above and
      // agent/taskCost.ts: prefer an explicit estimate (from plan_tasks'
      // args), fall back to the mechanical heuristic so this is never left
      // unset.
      costTier: costTier || estimateCostHeuristic(trimmedDescription),
      costNote: costNote?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    return entry;
  }

  setStatus(id: string, status: TaskStatus, summary?: string): TaskLedgerEntry | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    entry.status = status;
    if (summary !== undefined) entry.summary = summary;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  toJSON(): TaskLedgerEntry[] {
    return this.entries;
  }

  static fromJSON(data: TaskLedgerEntry[] | undefined): TaskLedger {
    return new TaskLedger(Array.isArray(data) ? data.filter((e) => e && typeof e.id === 'string') : []);
  }
}

const MAX_TASKS_IN_PROMPT = 40;
const MAX_PROMPT_CHARS = 3000;
const STATUS_MARK: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  failed: '[!]',
};

/** Depth of `entry` in the parentTaskId chain, cycle-safe (a corrupted/hand-edited ledger with a parent cycle degrades to "treat as depth so far" rather than looping forever). */
function depthOf(entry: TaskLedgerEntry, byId: Map<string, TaskLedgerEntry>): number {
  let depth = 0;
  let cur = entry;
  const seen = new Set<string>([entry.id]);
  while (cur.parentTaskId) {
    const parent = byId.get(cur.parentTaskId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth++;
    cur = parent;
  }
  return depth;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * Renders the ledger into the compact block spliced into every turn's
 * prompt (see buildTurnContextPrefix() in systemPrompt.ts) — the "context
 * can be derived from that, don't redo finished work" half of this feature.
 * Capped the same way milestones/memory/project-log already are (most
 * recent entries kept, oldest dropped) so a very long-running orchestrated
 * session's ledger can't itself become a context problem. Returns undefined
 * for an empty ledger so callers can concatenate unconditionally.
 */
export function renderTaskLedgerForPrompt(entries: TaskLedgerEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const kept = entries.slice(-MAX_TASKS_IN_PROMPT);
  const omitted = entries.length - kept.length;
  const lines = kept.map((e) => {
    const indent = '  '.repeat(depthOf(e, byId));
    const summarySuffix = e.summary ? ` — ${truncate(e.summary, 140)}` : '';
    // Cost-aware task planning: every entry has a tier by the time it's in
    // the ledger (see add() above) — old, pre-0.13.0 persisted sessions are
    // the one case it can still be missing, hence the fallback label rather
    // than assuming it's always present.
    const costTag = e.costTier ? `(${e.costTier}) ` : '';
    // 0.14.0 resumeTaskId: the id is only worth spending prompt tokens on for
    // tasks a fresh/resuming agent could actually act on — a 'done' task has
    // nothing to resume. Surfacing it here (rather than only in the JSON
    // manifest) is what lets the model actually pass resumeTaskId to
    // spawn_subagent instead of re-describing the same task as a brand new
    // one — see systemPrompt.ts's orchestration-mode instructions.
    const idSuffix = e.status !== 'done' ? ` [id: ${e.id}]` : '';
    return `${indent}${STATUS_MARK[e.status]} ${costTag}${truncate(e.description, 160)}${idSuffix}${summarySuffix}`;
  });
  let text = lines.join('\n');
  if (text.length > MAX_PROMPT_CHARS) {
    const trimmedLines: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const next = lines[i].length + 1;
      if (total + next > MAX_PROMPT_CHARS) break;
      trimmedLines.unshift(lines[i]);
      total += next;
    }
    text = trimmedLines.join('\n');
  }
  const unfinished = entries.filter((e) => e.status === 'pending' || e.status === 'in_progress').length;
  // Cost-aware task planning: an at-a-glance aggregate so the model (and
  // orchestration mode's dispatch decisions in particular) can see the
  // overall shape of the remaining work, not just each task's own tier in
  // isolation — see agent/taskCost.ts's summarizePlanCost()/renderPlanCostLine().
  const stillUnfinished = entries.filter((e) => e.status === 'pending' || e.status === 'in_progress');
  const costLine = stillUnfinished.length > 0 ? `\nRemaining task cost: ${renderPlanCostLine(summarizePlanCost(stillUnfinished))}.` : '';
  return (
    `## Task ledger (mechanically tracked — the mandatory checkpoint record of this session's task breakdown and progress). ` +
    `If you are a fresh/resuming agent picking this session back up after an interruption, READ THIS FIRST: anything marked [x] is already done — check its summary before redoing it. [~] means it was in progress when work stopped and may need to be resumed or verified rather than restarted from scratch. [!] failed and needs a different approach, not a retry of the exact same thing. Each task's (tier) is a rough cost estimate (cheap/moderate/expensive) — where there's no dependency reason to do otherwise, prefer working through cheap tasks first so an interruption preserves the most progress. The "[id: ...]" on any not-done task is that task's ledger id — when you decide to actually work an [~] or [!] task via spawn_subagent, pass that id as "resumeTaskId" instead of writing a fresh plan_tasks entry for it, so the sub-agent starts from its last known progress rather than from scratch.\n${text}${costLine}` +
    (omitted > 0 ? `\n(${omitted} earlier task(s) omitted — see the full ledger in session state)` : '') +
    (unfinished > 0 ? `\n(${unfinished} task(s) still pending/in-progress)` : '')
  );
}

/**
 * 0.14.0 checkpoint/task-manifest unification: renders the FULL, untruncated
 * current state of the ledger as a single human-readable Markdown document —
 * the human-readable twin of the JSON manifest (see ChatStore.writeTaskManifest()),
 * generated from the exact same TaskLedgerEntry[] rather than accumulated as
 * a separate parallel write. This replaces the pre-0.14.0 design where
 * ChatStore.appendTaskReport() hand-built one Markdown section per status
 * change and appended it: that was a second, independently-drifting
 * representation of task state (an event log, not a snapshot of current
 * state) — asking "is task X actually done" meant reading the whole file
 * looking for its last entry instead of just looking at the ledger. Calling
 * this function and overwriting the file on every change (see
 * ChatSession.onTaskLedgerChanged()) makes the .tasks.md file a pure,
 * always-current render of the same manifest state the JSON files and the
 * in-prompt digest (renderTaskLedgerForPrompt() above) both come from — one
 * source of truth, three presentations (prompt digest, JSON manifest,
 * Markdown report) instead of three sources of truth.
 *
 * Deliberately NOT capped/truncated the way renderTaskLedgerForPrompt() is —
 * this is a file meant to be opened and read by a human, not spliced into a
 * token-budgeted prompt, so every task gets its full description/summary and
 * its timestamps.
 */
export function renderTaskManifestMarkdown(entries: TaskLedgerEntry[]): string {
  if (entries.length === 0) {
    return '# Task ledger\n\n(no tasks recorded yet)\n';
  }
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const unfinished = entries.filter((e) => e.status === 'pending' || e.status === 'in_progress').length;
  const done = entries.filter((e) => e.status === 'done').length;
  const failed = entries.filter((e) => e.status === 'failed').length;
  const header =
    `# Task ledger\n\n` +
    `_Mechanically generated from this chat's live task ledger — a full re-render on every change, not an append-only log. ` +
    `${entries.length} task(s) total: ${done} done, ${failed} failed, ${unfinished} pending/in-progress. Last updated ${new Date().toISOString()}._\n\n`;
  const sections = entries.map((e) => {
    const indent = '  '.repeat(depthOf(e, byId));
    const parentLine = e.parentTaskId ? `\n${indent}- parent: \`${e.parentTaskId}\`` : '';
    const checkpointLine = e.checkpointId ? `\n${indent}- checkpoint: \`${e.checkpointId}\`` : '';
    const costLine = e.costTier ? `\n${indent}- cost: ${e.costTier}${e.costNote ? ` (${e.costNote})` : ''}` : '';
    const summaryLine = e.summary ? `\n\n${indent}${e.summary.replace(/\n/g, `\n${indent}`)}` : '';
    return (
      `${indent}## ${STATUS_MARK[e.status]} ${e.description}\n` +
      `${indent}- id: \`${e.id}\`\n` +
      `${indent}- status: ${e.status}` +
      `${costLine}${parentLine}${checkpointLine}\n` +
      `${indent}- created: ${e.createdAt} · updated: ${e.updatedAt}` +
      `${summaryLine}\n`
    );
  });
  return header + sections.join('\n');
}
