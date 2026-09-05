import { genId } from '../util/ids';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface TaskLedgerEntry {
  id: string;
  description: string;
  status: TaskStatus;
  /** Set once the task reaches 'done'/'failed' (and sometimes earlier, e.g. a sub-agent's own summary while still running) — the short "what happened" a resuming agent/human reads instead of redoing the work to find out. */
  summary?: string;
  /** Set when this task was created as part of decomposing a bigger parent task (see plan_tasks/spawn_subagent auto-instrumentation) — lets renderTaskLedgerForPrompt() show real hierarchy instead of one flat list. */
  parentTaskId?: string;
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

  add(description: string, parentTaskId?: string): TaskLedgerEntry {
    const now = new Date().toISOString();
    const entry: TaskLedgerEntry = {
      id: genId('task'),
      description: description.trim() || '(untitled task)',
      status: 'pending',
      parentTaskId: parentTaskId && this.get(parentTaskId) ? parentTaskId : undefined,
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
    return `${indent}${STATUS_MARK[e.status]} ${truncate(e.description, 160)}${summarySuffix}`;
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
  return (
    `## Task ledger (mechanically tracked — the mandatory checkpoint record of this session's task breakdown and progress). ` +
    `If you are a fresh/resuming agent picking this session back up after an interruption, READ THIS FIRST: anything marked [x] is already done — check its summary before redoing it. [~] means it was in progress when work stopped and may need to be resumed or verified rather than restarted from scratch. [!] failed and needs a different approach, not a retry of the exact same thing.\n${text}` +
    (omitted > 0 ? `\n(${omitted} earlier task(s) omitted — see the full ledger in session state)` : '') +
    (unfinished > 0 ? `\n(${unfinished} task(s) still pending/in-progress)` : '')
  );
}
