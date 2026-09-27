import * as vscode from 'vscode';
import { LlmProvider } from '../llm/provider';
import { StoredSession } from '../forge/chatStore';
import { UiTranscriptEntry } from '../webview/protocol';
import { sha1 } from '../util/hash';
import { cosineSimilarity } from '../util/vector';
import { logger } from '../util/logger';

const CHUNK_CHAR_BUDGET = 1500;
const MAX_CHUNKS_PER_SESSION = 200;
const EMBED_CONCURRENCY = 4;

export interface ChatChunk {
  sessionId: string;
  sessionTitle: string;
  chunkIndex: number;
  text: string;
  vector?: number[];
}

interface SessionIndexEntry {
  sessionId: string;
  /** Hash of the extracted searchable text at the time this session was last indexed — lets re-indexing skip untouched sessions entirely (most turns only append to the *current* session, so this makes per-turn re-indexing cheap). */
  contentHash: string;
  chunks: ChatChunk[];
}

interface ChatIndexCacheFile {
  version: 1;
  embeddingModel: string;
  sessions: SessionIndexEntry[];
}

export interface ChatSearchResult {
  sessionId: string;
  sessionTitle: string;
  snippet: string;
  score: number;
}

/**
 * The retrieval half of the memory system (see `.forge/memory.md` /
 * `MemoryStore` for the curated-facts half). This is `WorkspaceIndex`
 * (`src/indexing/workspaceIndex.ts`) applied to `.forge/chat/*.json`
 * transcripts instead of workspace files: chunk → embed → cosine-rank, with
 * the same keyword-search fallback when no embedding model is available.
 *
 * The whole point is answering "what happened / what did we decide earlier
 * in this project" without that history having to live in the live prompt —
 * so a long-running project's context never actually runs out, it just
 * becomes something the agent looks up instead of something it's forced to
 * keep re-reading in full every turn (see the context-window discussion in
 * README → Context management).
 *
 * Indexing is incremental and per-session: `indexSession()` is called once
 * per turn (see ChatSession.send()'s finally block) and only re-embeds a
 * session whose extracted text actually changed since last time, keyed by a
 * content hash — so a long chat's *earlier* turns are never re-embedded just
 * because a new message got appended.
 */
export class ChatMemoryIndex {
  private sessions = new Map<string, SessionIndexEntry>();
  private embeddingsAvailable = false;
  private cacheUri: vscode.Uri | undefined;
  private saveQueued = false;

  constructor(
    private ollama: LlmProvider,
    private storageUri: vscode.Uri | undefined,
    private getEmbeddingModel: () => string
  ) {
    if (this.storageUri) {
      this.cacheUri = vscode.Uri.joinPath(this.storageUri, 'forge-chat-index.json');
    }
  }

  status() {
    const chunks = [...this.sessions.values()].flatMap((s) => s.chunks);
    return {
      sessions: this.sessions.size,
      chunks: chunks.length,
      embeddingsAvailable: this.embeddingsAvailable,
    };
  }

  async loadCache(): Promise<void> {
    if (!this.cacheUri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as ChatIndexCacheFile;
      if (data.version === 1 && data.embeddingModel === this.getEmbeddingModel()) {
        this.sessions = new Map(data.sessions.map((s) => [s.sessionId, s]));
        this.embeddingsAvailable = data.sessions.some((s) => s.chunks.some((c) => c.vector));
      }
    } catch {
      /* no cache yet, or unreadable — fine, indexSession() rebuilds as sessions are touched */
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheUri || this.saveQueued) return;
    this.saveQueued = true;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri!);
      const data: ChatIndexCacheFile = {
        version: 1,
        embeddingModel: this.getEmbeddingModel(),
        sessions: [...this.sessions.values()],
      };
      await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify(data), 'utf8'));
    } catch (err) {
      logger.warn('Failed to save chat memory index cache', String(err));
    } finally {
      this.saveQueued = false;
    }
  }

  removeSession(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.saveCache().catch(() => {});
  }

  /** Re-indexes one session if (and only if) its searchable text has changed since last time. Cheap to call after every turn. */
  async indexSession(stored: StoredSession): Promise<void> {
    const text = extractSearchableText(stored);
    const contentHash = sha1(text);
    const prior = this.sessions.get(stored.id);
    if (prior && prior.contentHash === contentHash) return; // nothing new to embed

    const pieces = chunkText(text, CHUNK_CHAR_BUDGET).slice(0, MAX_CHUNKS_PER_SESSION);
    const chunks: ChatChunk[] = pieces.map((text, chunkIndex) => ({
      sessionId: stored.id,
      sessionTitle: stored.title,
      chunkIndex,
      text,
    }));

    const model = this.getEmbeddingModel();
    let anyEmbedded = false;
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= chunks.length) return;
        const vec = await this.ollama.embed(model, chunks[i].text.slice(0, 4000));
        if (vec) {
          chunks[i].vector = vec;
          anyEmbedded = true;
        }
      }
    };
    if (chunks.length > 0) {
      await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));
    }
    if (anyEmbedded) this.embeddingsAvailable = true;

    this.sessions.set(stored.id, { sessionId: stored.id, contentHash, chunks });
    await this.saveCache();
  }

  async search(query: string, k: number): Promise<ChatSearchResult[]> {
    const allChunks = [...this.sessions.values()].flatMap((s) => s.chunks);
    if (!this.embeddingsAvailable || allChunks.length === 0) {
      return keywordChatSearch(allChunks, query, k);
    }
    const qVec = await this.ollama.embed(this.getEmbeddingModel(), query);
    if (!qVec) return keywordChatSearch(allChunks, query, k);

    const scored = allChunks
      .filter((c) => c.vector)
      .map((c) => ({ chunk: c, score: cosineSimilarity(qVec, c.vector!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored.map(({ chunk, score }) => ({
      sessionId: chunk.sessionId,
      sessionTitle: chunk.sessionTitle,
      snippet: chunk.text.length > 800 ? chunk.text.slice(0, 800) + '…' : chunk.text,
      score,
    }));
  }
}

function keywordChatSearch(chunks: ChatChunk[], query: string, k: number): ChatSearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored = chunks
    .map((c) => {
      const lower = c.text.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
      return { chunk: c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map(({ chunk, score }) => ({
    sessionId: chunk.sessionId,
    sessionTitle: chunk.sessionTitle,
    snippet: chunk.text.length > 800 ? chunk.text.slice(0, 800) + '…' : chunk.text,
    score: score / terms.length,
  }));
}

/** Flattens a session's UI transcript into plain, prefixed lines — the same shape regardless of entry kind, so chunking downstream doesn't need to special-case anything. */
export function extractSearchableText(stored: StoredSession): string {
  const lines: string[] = [];
  for (const entry of stored.uiHistory as UiTranscriptEntry[]) {
    switch (entry.kind) {
      case 'user':
        if (entry.text) lines.push(`USER: ${entry.text}`);
        break;
      case 'assistant':
        if (entry.text) lines.push(`ASSISTANT: ${entry.text}`);
        break;
      case 'tool':
        if (entry.summary) lines.push(`TOOL ${entry.tool}: ${entry.summary}`);
        break;
      case 'plan':
        if (entry.text) lines.push(`PLAN: ${entry.text}`);
        break;
      case 'error':
        if (entry.text) lines.push(`ERROR: ${entry.text}`);
        break;
      case 'system':
        if (entry.text) lines.push(`SYSTEM: ${entry.text}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

/** Paragraph-aware greedy chunking by character budget — same idea as WorkspaceIndex's line-based chunking, just line-based doesn't fit chat transcripts (a single message is one logical unit, not N source lines). */
export function chunkText(text: string, budget: number): string[] {
  const paragraphs = text.split('\n').filter((l) => l.trim().length > 0);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const line of paragraphs) {
    if (currentLen > 0 && currentLen + line.length + 1 > budget) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
    if (currentLen >= budget) {
      chunks.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}
