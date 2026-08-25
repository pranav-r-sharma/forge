import * as vscode from 'vscode';
import * as fs from 'fs';
import { ChatMessage } from '../ollama/types';
import { UiTranscriptEntry } from '../webview/protocol';
import { CheckpointRecord } from '../agent/checkpoints';
import { CompactionCache } from '../agent/contextManager';
import { logger } from '../util/logger';

export type ForgeMode = 'agent' | 'ask' | 'plan' | 'auto' | 'outcome';

export interface StoredSession {
  id: string;
  title: string;
  mode: ForgeMode;
  model: string;
  createdAt: string;
  updatedAt: string;
  uiHistory: UiTranscriptEntry[];
  modelHistory: ChatMessage[];
  checkpoints?: CheckpointRecord[];
  compactionCache?: CompactionCache;
  /** Optional "definition of done" shell command for Agent/Auto/Outcome modes — see agentLoop.ts's verify-gated final-answer loop. */
  verifyCommand?: string;
  /** Counts turns since the last automatic memory-extraction review, so it only runs periodically rather than every turn — see ChatSession.maybeReviewForMemory(). */
  turnsSinceMemoryReview?: number;
  /** True once the user has explicitly renamed this chat (ChatSession.rename()) — guards the first-message auto-title logic in send() from clobbering a manual rename on a later turn. */
  titleManuallySet?: boolean;
  /** Per-chat context-window override (item "tweak context limits per chat") — undefined means "use forge.numCtx". See ChatSession.setNumCtxOverride(). */
  numCtxOverride?: number;
}

/** One line of the append-only `.forge/chat/<id>.log.jsonl` crash-recovery log — see item "Logging of important decisions/actions". */
export interface LogEntry {
  ts: string;
  kind: 'user' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'checkpoint' | 'mode_change' | 'verify' | 'memory_review';
  detail: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: ForgeMode;
  updatedAt: string;
  /** True once the user has closed this chat's tab. Closing no longer deletes anything (see CHANGELOG) — it just hides the chat from the open-tabs strip; the session file stays on disk and the chat is reachable from the "All chats" browser, which can reopen it (clearing this flag) or permanently delete it. Undefined/false = open. */
  closed?: boolean;
}

interface IndexFile {
  sessions: SessionSummary[];
}

/**
 * Persists chat sessions as JSON files under `.forge/chat/<id>.json` in the
 * repo itself (per your request — Cursor keeps this in app-local storage;
 * Forge keeps it in the workspace so it travels with the project / can be
 * committed if you want a record of how the agent got somewhere). A small
 * `.forge/chat/index.json` tracks titles/order without needing to read every
 * session file just to populate the tab strip.
 */
export class ChatStore {
  private chatDir: vscode.Uri;
  private indexUri: vscode.Uri;
  private counter = 0;

  /**
   * Serializes every operation below that does a read-modify-write on the
   * shared `index.json` (save/rename/setClosed/delete). This file is touched
   * constantly and from many independent places at once — a busy background
   * chat tab calls save() after nearly every agent event (every tool call,
   * every streamed message finalized), while the user might simultaneously
   * close, rename, or reopen a *different* chat in the foreground. Without
   * serialization, two of these can interleave their own independent
   * readIndex() -> mutate -> writeIndex() cycles: whichever call's write
   * lands last wins in full, silently discarding the other call's change —
   * e.g. a close's `closed: true` gets reverted back to open by a
   * slightly-later-landing save() that happened to read the index *before*
   * the close's write landed. That's the direct cause of "closing a chat
   * doesn't stick" and "a chat's open/closed state or title randomly
   * reverts." A single FIFO queue makes every one of these calls run fully
   * one-at-a-time, so each always reads the truly-current state before
   * writing — no lost updates, regardless of how many chats are active or
   * how fast events are firing. These are tiny local JSON files, so
   * serializing them costs nothing perceptible.
   */
  private queue: Promise<any> = Promise.resolve();
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // The chain itself must never reject, or every operation queued after a
    // failing one would be silently stuck forever waiting on a rejected
    // promise — settle it either way and let `run` (returned to the actual
    // caller) carry the real success/failure.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  constructor(private workspaceRoot: vscode.Uri) {
    this.chatDir = vscode.Uri.joinPath(workspaceRoot, '.forge', 'chat');
    this.indexUri = vscode.Uri.joinPath(this.chatDir, 'index.json');
  }

  newId(): string {
    this.counter += 1;
    return `sess_${Date.now().toString(36)}_${this.counter}`;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const idx = await this.readIndex();
    return idx.sessions.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async load(id: string): Promise<StoredSession | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.chatDir, `${id}.json`));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredSession;
    } catch (err) {
      return this.recoverCorruptedSession(id, err);
    }
  }

  /**
   * Best-effort recovery for a session whose `<id>.json` is missing or
   * unparseable. This is the fix for "older chats sometimes won't open, but
   * rename/delete still work": before 0.8.1, concurrent save() calls for the
   * same session could race on a shared, non-unique temp filename and leave
   * `<id>.json` truncated or overwritten with the wrong content — 0.8.1
   * fixed the ongoing cause (see CHANGELOG), but any file that was ALREADY
   * damaged by it before upgrading stays damaged; without this, such a
   * session could never be opened again. Rename/delete "still worked" only
   * because they operate on `index.json` (rename patches the title there
   * even when the full-file update it also attempts silently no-ops on an
   * unreadable file; delete just removes files regardless of their
   * validity) — never on the actually-broken content file, which is exactly
   * why those two looked fine while opening did not.
   *
   * Two-step recovery: try a leftover `<id>.json.tmp` first — an abandoned
   * write from the same historical race might still hold valid, if slightly
   * stale, content. If that's also unusable, synthesize a minimal session
   * from whatever `index.json` still knows (title/mode) with a visible note
   * explaining the loss, so the chat becomes usable again instead of a
   * permanent dead end. Either way, the recovered content is saved back
   * immediately so this doesn't need recovering again on the next open.
   */
  private async recoverCorruptedSession(id: string, originalErr: unknown): Promise<StoredSession | undefined> {
    // Tier 1: a leftover `<id>.json.tmp` — an abandoned write from the
    // historical pre-0.8.1 race, or (0.9.1+) a .tmp left behind by a
    // validate-before-commit rejection in saveInternal(). Might still hold
    // valid, if slightly stale, content.
    const tmp = vscode.Uri.joinPath(this.chatDir, `${id}.json.tmp`);
    try {
      const bytes = await vscode.workspace.fs.readFile(tmp);
      const recovered = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredSession;
      logger.warn(`Chat session ${id} failed to load (${String(originalErr)}); recovered from a leftover .tmp file`);
      // Bypasses the queue deliberately — see renameInternal()'s identical
      // saveInternal() call for why: load() can itself be called from
      // within an already-enqueued operation (e.g. rename's fallback read),
      // and enqueuing here would deadlock waiting on that outer operation to
      // finish while it's waiting on this one.
      await this.saveInternal(recovered);
      try {
        await vscode.workspace.fs.delete(tmp);
      } catch {
        /* best-effort cleanup, not load-bearing */
      }
      return recovered;
    } catch {
      /* no usable .tmp — fall through to tier 2 */
    }

    // Tier 2 (0.9.1+): the rolling `<id>.json.bak` written by
    // saveInternal()'s backup-rotation step — an exact copy of the
    // session as of its second-to-last save. Up to one turn behind current,
    // but a COMPLETE valid session rather than a reconstruction, so this is
    // preferred over rebuilding from the crash log in tier 3.
    const bak = vscode.Uri.joinPath(this.chatDir, `${id}.json.bak`);
    try {
      const bytes = await vscode.workspace.fs.readFile(bak);
      const recovered = JSON.parse(Buffer.from(bytes).toString('utf8')) as StoredSession;
      logger.warn(`Chat session ${id} failed to load (${String(originalErr)}) and had no usable .tmp; recovered from the rolling .bak backup (may be missing the most recent turn)`);
      await this.saveInternal(recovered);
      return recovered;
    } catch {
      /* no usable .bak either — fall through to tier 3 */
    }

    const idx = await this.readIndex();
    const summary = idx.sessions.find((s) => s.id === id);
    if (!summary) return undefined; // no index entry either — this id genuinely never existed, not a recovery case

    // Tier 3 (0.9.1+): rebuild a readable-but-lossy transcript from the
    // append-only crash-recovery log (see appendLog()/readLog()). The log
    // uses a different write mechanism (plain fs.appendFile, never
    // write-then-rename) and was never at risk from the original corruption
    // bug, so it's often intact even when both tiers above come up empty —
    // e.g. a session that only had one save ever before this 0.9.1
    // hardening shipped, so no .bak was ever written for it.
    const log = await this.readLog(id);
    if (log.length > 0) {
      const rebuilt = this.buildShellFromLog(id, summary, log);
      logger.warn(`Chat session ${id} failed to load (${String(originalErr)}) and had no usable .tmp or .bak; reconstructed ${log.length} entries from the crash-recovery log`);
      await this.saveInternal(rebuilt);
      return rebuilt;
    }

    // Tier 4: nothing recoverable at all — synthesize a minimal empty shell
    // so the chat is at least usable again, with a visible note explaining
    // the loss.
    logger.warn(`Chat session ${id} failed to load (${String(originalErr)}) and has no recoverable .tmp, .bak, or log; starting an empty shell so it can still be opened`);
    const shell = this.buildEmptyShell(id, summary);
    await this.saveInternal(shell);
    return shell;
  }

  /** Tier 4 recovery: a minimal session shell with a visible note explaining that the earlier conversation is gone. Extracted so recoverCorruptedSession() can reuse the exact same message text it always has. */
  private buildEmptyShell(id: string, summary: SessionSummary): StoredSession {
    const now = new Date().toISOString();
    return {
      id,
      title: summary.title,
      mode: summary.mode,
      model: '',
      createdAt: now,
      updatedAt: now,
      uiHistory: [
        {
          kind: 'error',
          id: `recovered_${id}`,
          text:
            "This chat's saved history could not be read (the file was corrupted or lost, most likely by a save-file race condition fixed in Forge 0.8.1). The chat is usable again from here on, but the earlier conversation is gone. If this keeps happening, please report it.",
        },
      ],
      modelHistory: [],
    };
  }

  /**
   * Tier 3 recovery: rebuilds a readable transcript from the append-only
   * crash-recovery log when both `.tmp` and `.bak` come up empty. This is
   * lossy by construction — ChatSession truncates most log entries before
   * writing them (user/assistant text to 300 chars, tool call/result/verify
   * detail to ~200 chars — see the `this.log(...)` call sites in
   * chatSession.ts) specifically to keep the log file itself small, and
   * entries that don't map to a chat bubble (tool calls, mode changes,
   * checkpoints, memory reviews) are rendered as plain system notes rather
   * than reconstructed UI state — a tool's structured args/result are gone,
   * only the truncated summary string survives. This is meant to recover
   * SOMETHING legible, not to perfectly restore the original conversation —
   * the disclaimer bubble at the top says so explicitly.
   */
  private buildShellFromLog(id: string, summary: SessionSummary, entries: LogEntry[]): StoredSession {
    const now = new Date().toISOString();
    const uiHistory: UiTranscriptEntry[] = [
      {
        kind: 'warning',
        id: `recovered_log_${id}`,
        text:
          "This chat's saved history was lost (the file was corrupted or missing, and no backup copy was available). What follows was reconstructed from Forge's crash-recovery log and may be incomplete or truncated — treat it as a best-effort summary, not the exact original conversation.",
        details: [],
      },
    ];
    entries.forEach((entry, i) => {
      const entryId = `recovered_log_${id}_${i}`;
      switch (entry.kind) {
        case 'user':
          uiHistory.push({ kind: 'user', id: entryId, text: entry.detail });
          break;
        case 'final':
          uiHistory.push({ kind: 'assistant', id: entryId, text: entry.detail });
          break;
        case 'error':
          uiHistory.push({ kind: 'error', id: entryId, text: entry.detail });
          break;
        default:
          uiHistory.push({ kind: 'system', id: entryId, text: `[${entry.kind}] ${entry.detail}` });
          break;
      }
    });
    return {
      id,
      title: summary.title,
      mode: summary.mode,
      model: '',
      createdAt: now,
      updatedAt: now,
      uiHistory,
      modelHistory: [],
    };
  }

  async save(session: StoredSession): Promise<void> {
    // Also serializes concurrent save() calls for the SAME session against
    // each other (pushEntry() fires one per tool call/result/streamed
    // message, not awaited/queued at the call site, so several can easily be
    // in flight at once during a busy turn) — without this they'd all share
    // the same `<id>.json.tmp` path and race on it directly, which could let
    // an older call's rename land *after* a newer call's, silently reverting
    // the session file to stale content.
    return this.enqueue(() => this.saveInternal(session));
  }

  private async saveInternal(session: StoredSession): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.chatDir);
      const target = vscode.Uri.joinPath(this.chatDir, `${session.id}.json`);
      // Write-then-rename rather than writing the target path directly: if
      // the extension host crashes or is killed mid-write, a direct write
      // can leave a half-written, unparseable JSON file behind — corrupting
      // the one copy of this conversation's history. Writing to a temp file
      // first and renaming over the target is effectively atomic on both
      // APFS and ext4/NTFS, so the on-disk file is always either the old
      // complete version or the new complete version, never a partial one.
      const tmp = vscode.Uri.joinPath(this.chatDir, `${session.id}.json.tmp`);
      const serialized = Buffer.from(JSON.stringify(session, null, 2), 'utf8');
      await vscode.workspace.fs.writeFile(tmp, serialized);

      // Validate-before-commit (0.9.1+): read back exactly what was just
      // written and confirm it parses before letting it become the session
      // of record. writeFile() not throwing only means the OS accepted the
      // write call — it doesn't guarantee every byte actually landed (a
      // full disk, a flaky network filesystem, etc. can still produce
      // truncated or garbled bytes on readback). Catching that here, before
      // rename(), means a bad write aborts cleanly and leaves whatever was
      // previously at `target` untouched, instead of promoting corrupt
      // bytes into the one file this session depends on.
      try {
        const readBack = await vscode.workspace.fs.readFile(tmp);
        JSON.parse(Buffer.from(readBack).toString('utf8'));
      } catch (validateErr) {
        logger.warn(`Refusing to persist chat session ${session.id}: just-written .tmp file failed to validate (${String(validateErr)}); leaving the previously saved version untouched`);
        try {
          await vscode.workspace.fs.delete(tmp);
        } catch {
          /* best-effort cleanup — a leftover .tmp here is still recoverable by tier 1 of recoverCorruptedSession() if it ever matters */
        }
        return;
      }

      // Backup rotation (0.9.1+): before overwriting `target`, best-effort
      // copy its CURRENT bytes to `<id>.json.bak` — a rolling,
      // one-generation-back backup that survives even if this new save
      // later turns out to be wrong in some way validation above can't
      // catch (e.g. a real bug wrote bad-but-valid-JSON content). Only
      // rotate if the current target is itself valid JSON: if we're here
      // via recoverCorruptedSession() re-persisting recovered content over
      // a file that was already corrupt, blindly copying those corrupt
      // bytes into .bak would silently destroy a previously good backup
      // instead of preserving one.
      try {
        const priorBytes = await vscode.workspace.fs.readFile(target);
        JSON.parse(Buffer.from(priorBytes).toString('utf8'));
        const bak = vscode.Uri.joinPath(this.chatDir, `${session.id}.json.bak`);
        await vscode.workspace.fs.writeFile(bak, priorBytes);
      } catch {
        /* no existing target yet (first save of a new session), or it was already corrupt — nothing valid to back up */
      }

      await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
      const idx = await this.readIndex();
      // Preserve the existing closed/open flag — a session's own content
      // (title, mode, transcript) is saved constantly as you chat, but
      // whether its tab is open or archived is separate, tab-strip-level
      // state that setClosed() owns; save() must not silently reopen an
      // archived chat just because a background turn persisted it.
      const prior = idx.sessions.find((s) => s.id === session.id);
      const summary: SessionSummary = { id: session.id, title: session.title, mode: session.mode, updatedAt: session.updatedAt, closed: prior?.closed };
      const others = idx.sessions.filter((s) => s.id !== session.id);
      await this.writeIndex({ sessions: [...others, summary] });
    } catch (err) {
      logger.warn('Failed to persist chat session', String(err));
    }
  }

  /**
   * Renames a chat by id, updating both the index (so the tab strip / All
   * Chats panel reflect it immediately) and the full session file if it
   * exists on disk (so the rename survives a reload without waiting for the
   * next turn to persist it). Used by the "All Chats" panel to rename a
   * session that isn't currently loaded into a live ChatSession — a live
   * session should instead call ChatSession.rename(), which also sets
   * titleManuallySet so a later auto-title never clobbers it.
   */
  async rename(id: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) return;
    // Note: this calls save() internally (via the `stored` branch below),
    // which itself enqueues on the same queue — that's fine, enqueue() calls
    // nest/chain correctly since each is a distinct link appended to
    // `this.queue`, not a re-entrant lock. What matters is the index
    // read-modify-write below happens as one atomic step relative to every
    // other queued operation.
    return this.enqueue(() => this.renameInternal(id, clean));
  }

  private async renameInternal(id: string, clean: string): Promise<void> {
    const idx = await this.readIndex();
    const target = idx.sessions.find((s) => s.id === id);
    if (target) {
      target.title = clean;
      await this.writeIndex(idx);
    }
    const stored = await this.load(id);
    if (stored) {
      stored.title = clean;
      stored.titleManuallySet = true;
      await this.saveInternal(stored);
    }
  }

  /** Archives (closed=true) or reopens (closed=false) a chat without touching its content — see SessionSummary.closed. A no-op if the session isn't in the index (e.g. already deleted). */
  async setClosed(id: string, closed: boolean): Promise<void> {
    return this.enqueue(async () => {
      try {
        const idx = await this.readIndex();
        const target = idx.sessions.find((s) => s.id === id);
        if (!target) return;
        target.closed = closed;
        await this.writeIndex(idx);
      } catch (err) {
        logger.warn('Failed to update chat closed state', String(err));
      }
    });
  }

  /**
   * Append-only crash-recovery log, `.forge/chat/<id>.log.jsonl` — one JSON
   * line per significant event (tool call/result, final answer, error,
   * checkpoint, mode change). Unlike `save()` (a full snapshot rewritten on
   * every change), this only ever grows, so even if the extension host dies
   * mid-session — before the next full `save()` lands — the log still has a
   * record of what the agent was doing and decided, right up to the crash.
   * Best-effort: a logging failure must never break the actual turn.
   */
  async appendLog(id: string, entry: LogEntry): Promise<void> {
    try {
      const dir = vscode.Uri.joinPath(this.chatDir);
      await vscode.workspace.fs.createDirectory(dir);
      const path = vscode.Uri.joinPath(dir, `${id}.log.jsonl`).fsPath;
      await fs.promises.appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      logger.warn('Failed to append chat log', String(err));
    }
  }

  /** Reads back the crash-recovery log for a session, oldest first. Returns an empty array if none exists. Useful after a crash to see the last few decisions/actions even if the full JSON snapshot is stale or missing. */
  async readLog(id: string): Promise<LogEntry[]> {
    try {
      const path = vscode.Uri.joinPath(this.chatDir, `${id}.log.jsonl`).fsPath;
      const raw = await fs.promises.readFile(path, 'utf8');
      return raw
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean)
        .map((l: string) => {
          try {
            return JSON.parse(l) as LogEntry;
          } catch {
            return undefined;
          }
        })
        .filter((e: LogEntry | undefined): e is LogEntry => !!e);
    } catch {
      return [];
    }
  }

  /**
   * Item "documentation skill — every major decision, checkpoint, error and
   * progress gets logged, and that can become context for new chats": a
   * single workspace-wide, human-readable `.forge/project-log.md`,
   * complementing (not duplicating) the per-session `.forge/chat/<id>.log.jsonl`
   * crash-recovery log above. That log is per-chat, JSONL, and meant for
   * machine reconstruction after data loss; this one is cross-chat, plain
   * Markdown, and meant to actually be read — by a person opening it (**Forge:
   * Open Project Log**) or by a brand-new chat's system prompt (see
   * ChatSession.send()'s projectLogText), so starting a new chat isn't
   * starting from zero context about what's already been done in this
   * project. Reuses the same mechanically-generated milestone summary
   * (chat/milestones.ts) that's already attached to each checkpoint — "unify
   * into one system," not a fourth logging mechanism. Best-effort/append-only,
   * same reasoning as appendLog(): a logging failure must never break the
   * turn that just completed.
   */
  async appendProjectLog(chatTitle: string, text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    try {
      const dir = vscode.Uri.joinPath(this.workspaceRoot, '.forge');
      await vscode.workspace.fs.createDirectory(dir);
      const stamp = new Date().toISOString();
      const line = `- [${stamp}] (${chatTitle}) ${clean}\n`;
      await fs.promises.appendFile(this.projectLogPath(), line, 'utf8');
    } catch (err) {
      logger.warn('Failed to append project log', String(err));
    }
  }

  projectLogPath(): string {
    return vscode.Uri.joinPath(this.workspaceRoot, '.forge', 'project-log.md').fsPath;
  }

  /**
   * What gets spliced into every chat's system prompt (the actual fix for
   * "a new chat starts with zero knowledge of what happened in every other
   * chat before it") — capped the same way memory.ts's renderForPrompt() is,
   * keeping the most recent entries so the cap can never itself blow the
   * context budget it exists to protect.
   */
  async readProjectLogForPrompt(maxChars = 3000): Promise<string> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.projectLogPath(), 'utf8');
    } catch {
      return '';
    }
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return '';
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (total + line.length + 1 > maxChars) break;
      kept.unshift(line);
      total += line.length + 1;
    }
    const omitted = lines.length - kept.length;
    return `## Project log (from .forge/project-log.md — a running, cross-chat record of what's already happened in this project; use it as context, and don't repeat work it says is already done)\n${kept.join('\n')}${omitted > 0 ? `\n(${omitted} earlier entries omitted — see .forge/project-log.md)` : ''}`;
  }

  async delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.json`));
      } catch {
        /* already gone */
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.json.bak`));
      } catch {
        /* already gone / never existed */
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.log.jsonl`));
      } catch {
        /* already gone / never existed */
      }
      const idx = await this.readIndex();
      await this.writeIndex({ sessions: idx.sessions.filter((s) => s.id !== id) });
    });
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.indexUri);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch {
      return { sessions: [] };
    }
  }

  private async writeIndex(idx: IndexFile): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.chatDir);
      // Same write-then-rename reasoning as save() above: index.json is read
      // by every tab-strip refresh, so a direct write that's interrupted
      // partway (host crash/kill) could leave the one file every chat's
      // open/closed state and title lives in truncated and unparseable —
      // readIndex()'s catch-all would then silently fall back to "no chats,"
      // which looks like every saved chat vanished. Tmp+rename keeps this
      // file always either the old or new complete version, never partial.
      const tmp = vscode.Uri.joinPath(this.chatDir, 'index.json.tmp');
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(idx, null, 2), 'utf8'));
      await vscode.workspace.fs.rename(tmp, this.indexUri, { overwrite: true });
    } catch (err) {
      logger.warn('Failed to write chat index', String(err));
    }
  }
}

export function deriveTitle(firstUserText: string): string {
  const clean = firstUserText.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? clean.slice(0, 48) + '…' : clean || 'New chat';
}
