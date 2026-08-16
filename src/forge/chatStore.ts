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
    } catch {
      return undefined;
    }
  }

  async save(session: StoredSession): Promise<void> {
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
      await vscode.workspace.fs.writeFile(tmp, Buffer.from(JSON.stringify(session, null, 2), 'utf8'));
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
      await this.save(stored);
    }
  }

  /** Archives (closed=true) or reopens (closed=false) a chat without touching its content — see SessionSummary.closed. A no-op if the session isn't in the index (e.g. already deleted). */
  async setClosed(id: string, closed: boolean): Promise<void> {
    try {
      const idx = await this.readIndex();
      const target = idx.sessions.find((s) => s.id === id);
      if (!target) return;
      target.closed = closed;
      await this.writeIndex(idx);
    } catch (err) {
      logger.warn('Failed to update chat closed state', String(err));
    }
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

  async delete(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.json`));
    } catch {
      /* already gone */
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.log.jsonl`));
    } catch {
      /* already gone / never existed */
    }
    const idx = await this.readIndex();
    await this.writeIndex({ sessions: idx.sessions.filter((s) => s.id !== id) });
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
      await vscode.workspace.fs.writeFile(this.indexUri, Buffer.from(JSON.stringify(idx, null, 2), 'utf8'));
    } catch (err) {
      logger.warn('Failed to write chat index', String(err));
    }
  }
}

export function deriveTitle(firstUserText: string): string {
  const clean = firstUserText.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? clean.slice(0, 48) + '…' : clean || 'New chat';
}
