/**
 * Per-session checkpoint bookkeeping — the pure "what state should the
 * workspace and transcript be in" logic, kept free of any `vscode` API so it
 * can be unit-tested directly (see _devtools/runtime_test/test_checkpoints.ts).
 * The actual disk reads/writes happen in ChatSession, which owns a
 * CheckpointStore per conversation and feeds it real file content.
 *
 * Design: a checkpoint is created at the start of every user turn (Cursor's
 * model — "restore to here" per message, not a separate manual action). It
 * doesn't snapshot anything up front (scanning the whole workspace would be
 * slow and mostly wasted); instead it lazily records a file's content the
 * FIRST time that file is about to be written after the checkpoint began.
 * That's exactly what's needed to undo everything from that point on: for
 * any path, the earliest "before" value recorded at-or-after a given
 * checkpoint equals that path's true state at the moment that checkpoint
 * started (whether or not that specific checkpoint's turn touched it) —
 * because file content only ever changes via a recorded write.
 */
export interface CheckpointRecord {
  id: string;
  label: string;
  createdAt: string;
  /** Index into the session's uiHistory array where this checkpoint begins (i.e. the user message that starts the turn). */
  uiHistoryIndex: number;
  /** Length of modelHistory (the array sent to Ollama) at checkpoint creation time. */
  modelHistoryLength: number;
  /** relativePath -> file content immediately before the first write after this checkpoint began. `null` = the file did not exist yet. */
  fileSnapshots: Record<string, string | null>;
  /**
   * A short, mechanically-generated (NOT model-generated) one-line digest of
   * what happened during this turn — tools called, files touched, command
   * outcome — set once the turn completes (see ChatSession.send()'s finally
   * block / chat/milestones.ts). This is the "milestone log" item: unlike
   * contextManager.ts's compaction summary (an LLM call, made only once a
   * session grows large enough to need it, and lossy), every turn gets one
   * of these for free, deterministically, the moment it finishes — so a
   * session's context can always be reconstructed from a cheap, always-
   * available table of contents instead of only from summarization. Absent
   * for a checkpoint whose turn hasn't finished yet (still in progress or
   * was aborted before the finally block ran).
   */
  milestone?: string;
}

export interface ResolvedRestore {
  target: CheckpointRecord;
  /** relativePath -> content to restore each touched file to (null = the file should be deleted, it didn't exist at the checkpoint). */
  fileStates: Record<string, string | null>;
  /** The checkpoint list to keep (everything up to and including the target) — checkpoints after it are no longer valid once restored. */
  remaining: CheckpointRecord[];
}

export class CheckpointStore {
  private checkpoints: CheckpointRecord[] = [];

  list(): CheckpointRecord[] {
    return this.checkpoints.slice();
  }

  /** Starts a new checkpoint epoch. Subsequent recordBeforeWrite() calls attach to this one until the next begin(). */
  begin(record: Omit<CheckpointRecord, 'fileSnapshots'>) {
    this.checkpoints.push({ ...record, fileSnapshots: {} });
  }

  /** Call right before a file at `relPath` is actually written to disk. No-ops if this path was already recorded for the active checkpoint, or if there's no active checkpoint. */
  recordBeforeWrite(relPath: string, priorContent: string | null) {
    const active = this.checkpoints[this.checkpoints.length - 1];
    if (!active) return;
    if (!(relPath in active.fileSnapshots)) active.fileSnapshots[relPath] = priorContent;
  }

  /** Attaches (or overwrites) a checkpoint's milestone digest — see CheckpointRecord.milestone. No-op if the id no longer exists (e.g. checkpoints after it were already dropped by a restore). */
  setMilestone(id: string, milestone: string) {
    const record = this.checkpoints.find((c) => c.id === id);
    if (record) record.milestone = milestone;
  }

  /** Computes what restoring to `id` would do, without mutating anything. Returns undefined if `id` isn't found. */
  resolveRestore(id: string): ResolvedRestore | undefined {
    const idx = this.checkpoints.findIndex((c) => c.id === id);
    if (idx === -1) return undefined;
    const target = this.checkpoints[idx];
    const relevant = this.checkpoints.slice(idx);
    const fileStates: Record<string, string | null> = {};
    for (const c of relevant) {
      for (const [path, content] of Object.entries(c.fileSnapshots)) {
        if (!(path in fileStates)) fileStates[path] = content;
      }
    }
    return { target, fileStates, remaining: this.checkpoints.slice(0, idx + 1) };
  }

  /** Resolves and commits the restore: drops checkpoints after `id` (they're invalid once we've rewound past them). Returns undefined if `id` isn't found. */
  applyRestore(id: string): ResolvedRestore | undefined {
    const resolved = this.resolveRestore(id);
    if (!resolved) return undefined;
    this.checkpoints = resolved.remaining;
    return resolved;
  }

  toJSON(): CheckpointRecord[] {
    return this.checkpoints;
  }

  static fromJSON(records: CheckpointRecord[] | undefined): CheckpointStore {
    const store = new CheckpointStore();
    if (Array.isArray(records)) store.checkpoints = records;
    return store;
  }
}
