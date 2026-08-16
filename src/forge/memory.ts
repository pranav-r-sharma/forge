import * as vscode from 'vscode';
import { logger } from '../util/logger';

const MAX_RENDER_CHARS = 4000;
const MAX_FACT_CHARS = 500;

/**
 * The durable-facts half of the memory system (see ROADMAP.md "Memories" /
 * README "Context management"). A `search_chat_history` index answers "what
 * happened before" — this answers "what do I need to always know". It's a
 * single plain-text file, `.forge/memory.md`, one fact per line, injected
 * into every system prompt (parallel to `.forge/rules/`) so it's never at
 * the mercy of context-window compaction. The agent curates it itself via
 * the `remember` tool; you can also hand-edit it (Forge: Open Memory File).
 *
 * Deliberately NOT re-embedded/indexed like chat history — it's meant to
 * stay small (a few dozen lines of "this repo uses pnpm", "the user prefers
 * tabs", "staging DB creds live in .env.staging"), not become a second
 * knowledge base. If it grows past what's useful to always inject, that's a
 * sign some of its lines belong in a `.forge/rules/*.md` file instead.
 */
export class MemoryStore {
  private uri: vscode.Uri;

  constructor(private workspaceRoot: vscode.Uri) {
    this.uri = vscode.Uri.joinPath(workspaceRoot, '.forge', 'memory.md');
  }

  fsPath(): string {
    return this.uri.fsPath;
  }

  async readRaw(): Promise<string> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return '';
    }
  }

  private async writeRaw(text: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceRoot, '.forge'));
    await vscode.workspace.fs.writeFile(this.uri, Buffer.from(text, 'utf8'));
  }

  private facts(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .map((l) => (l.startsWith('- ') ? l.slice(2).trim() : l))
      .filter(Boolean);
  }

  /** Every currently-remembered fact, one string each, no bullet prefix — used by the automatic memory-review pass (memoryReview.ts) to avoid re-proposing something already saved. */
  async listFacts(): Promise<string[]> {
    return this.facts(await this.readRaw());
  }

  /** What gets spliced into the system prompt — capped so a large memory file can't itself blow the context budget it exists to protect. */
  async renderForPrompt(): Promise<string> {
    const raw = await this.readRaw();
    const facts = this.facts(raw);
    if (facts.length === 0) return '';
    let body = facts.map((f) => `- ${f}`).join('\n');
    if (body.length > MAX_RENDER_CHARS) {
      // Keep the most recent facts (end of file) — those are more likely to
      // reflect the current state of the project than very old ones, and
      // this is exactly the situation renderForPrompt exists to bound.
      const kept: string[] = [];
      let total = 0;
      for (let i = facts.length - 1; i >= 0; i--) {
        const line = `- ${facts[i]}`;
        if (total + line.length + 1 > MAX_RENDER_CHARS) break;
        kept.unshift(line);
        total += line.length + 1;
      }
      body = kept.join('\n') + `\n(${facts.length - kept.length} older fact(s) omitted — see .forge/memory.md)`;
    }
    return `## Remembered facts (from .forge/memory.md — durable, curated by you and the user; trust these over guessing)\n${body}`;
  }

  /**
   * Appends a new fact, de-duplicating case-insensitively against existing
   * lines so a model that calls `remember` on the same fact every few turns
   * doesn't slowly turn the file into noise.
   */
  async addFact(fact: string): Promise<{ added: boolean; reason?: string }> {
    const clean = fact.replace(/\s+/g, ' ').trim();
    if (!clean) return { added: false, reason: 'Empty fact.' };
    const capped = clean.length > MAX_FACT_CHARS ? clean.slice(0, MAX_FACT_CHARS) + '…' : clean;

    const raw = await this.readRaw();
    const existing = this.facts(raw);
    if (existing.some((f) => f.toLowerCase() === capped.toLowerCase())) {
      return { added: false, reason: 'Already remembered.' };
    }

    const next = existing.length > 0 ? existing.concat(capped) : [capped];
    try {
      await this.writeRaw(next.map((f) => `- ${f}`).join('\n') + '\n');
      return { added: true };
    } catch (err) {
      logger.warn('Failed to write .forge/memory.md', String(err));
      return { added: false, reason: 'Failed to write .forge/memory.md.' };
    }
  }
}
