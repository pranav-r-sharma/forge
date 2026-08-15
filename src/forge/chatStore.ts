import * as vscode from 'vscode';
import { ChatMessage } from '../ollama/types';
import { UiTranscriptEntry } from '../webview/protocol';
import { logger } from '../util/logger';

export type ForgeMode = 'agent' | 'ask' | 'plan';

export interface StoredSession {
  id: string;
  title: string;
  mode: ForgeMode;
  model: string;
  createdAt: string;
  updatedAt: string;
  uiHistory: UiTranscriptEntry[];
  modelHistory: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: ForgeMode;
  updatedAt: string;
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
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.chatDir, `${session.id}.json`),
        Buffer.from(JSON.stringify(session, null, 2), 'utf8')
      );
      const idx = await this.readIndex();
      const summary: SessionSummary = { id: session.id, title: session.title, mode: session.mode, updatedAt: session.updatedAt };
      const others = idx.sessions.filter((s) => s.id !== session.id);
      await this.writeIndex({ sessions: [...others, summary] });
    } catch (err) {
      logger.warn('Failed to persist chat session', String(err));
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.chatDir, `${id}.json`));
    } catch {
      /* already gone */
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
