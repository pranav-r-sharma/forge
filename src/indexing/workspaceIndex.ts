import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { isIgnoredDir, looksBinary, toRelative } from '../util/paths';
import { sha1 } from '../util/hash';
import { keywordCodebaseSearch } from './keywordSearch';
import { logger } from '../util/logger';

const CHUNK_LINES = 120;
const MAX_FILES = 3000;
const MAX_CHUNKS = 4000;
const MAX_FILE_BYTES_FOR_INDEX = 512 * 1024;
const EMBED_CONCURRENCY = 4;

interface IndexedChunk {
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
  vector?: number[];
}

interface IndexCacheFile {
  version: 1;
  embeddingModel: string;
  chunks: IndexedChunk[];
}

/**
 * A lightweight semantic index over the open workspace: chunks text files by
 * line ranges, embeds each chunk with the configured Ollama embedding model,
 * and answers `search()` with cosine-similarity ranking. Falls back to plain
 * keyword search automatically if no embedding model is installed/reachable
 * — @codebase / search_codebase always returns *something* useful either way.
 */
export class WorkspaceIndex {
  private chunks: IndexedChunk[] = [];
  private embeddingsAvailable = false;
  private building = false;
  private cacheUri: vscode.Uri | undefined;

  constructor(
    private ollama: OllamaClient,
    private workspaceRoot: vscode.Uri,
    private storageUri: vscode.Uri | undefined,
    private getEmbeddingModel: () => string
  ) {
    if (this.storageUri) {
      this.cacheUri = vscode.Uri.joinPath(this.storageUri, 'forge-index.json');
    }
  }

  status() {
    return {
      indexed: this.chunks.filter((c) => c.vector).length,
      total: this.chunks.length,
      embeddingsAvailable: this.embeddingsAvailable,
    };
  }

  async loadCache(): Promise<void> {
    if (!this.cacheUri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as IndexCacheFile;
      if (data.version === 1 && data.embeddingModel === this.getEmbeddingModel()) {
        this.chunks = data.chunks;
        this.embeddingsAvailable = this.chunks.some((c) => c.vector);
      }
    } catch {
      /* no cache yet, or unreadable — that's fine, build() will create one */
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri!);
      const data: IndexCacheFile = { version: 1, embeddingModel: this.getEmbeddingModel(), chunks: this.chunks };
      await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify(data), 'utf8'));
    } catch (err) {
      logger.warn('Failed to save workspace index cache', String(err));
    }
  }

  async build(onProgress?: (message: string, fraction?: number) => void, token?: vscode.CancellationToken): Promise<void> {
    if (this.building) return;
    this.building = true;
    try {
      onProgress?.('Scanning workspace files…');
      const files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target,.forge-index}/**',
        MAX_FILES
      );

      const priorByKey = new Map(this.chunks.map((c) => [`${c.path}#${c.startLine}`, c]));
      const newChunks: IndexedChunk[] = [];

      for (const uri of files) {
        if (token?.isCancellationRequested) break;
        if (looksBinary(uri.fsPath)) continue;
        const rel = toRelative(this.workspaceRoot, uri);
        if (rel.split('/').some(isIgnoredDir)) continue;

        let bytes: Uint8Array;
        try {
          bytes = await vscode.workspace.fs.readFile(uri);
        } catch {
          continue;
        }
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES_FOR_INDEX) continue;
        const text = Buffer.from(bytes).toString('utf8');
        if (/�/.test(text.slice(0, 200))) continue; // likely binary/non-utf8

        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += CHUNK_LINES) {
          const slice = lines.slice(i, i + CHUNK_LINES);
          const chunkText = slice.join('\n');
          if (!chunkText.trim()) continue;
          const hash = sha1(chunkText);
          const key = `${rel}#${i + 1}`;
          const prior = priorByKey.get(key);
          if (prior && prior.hash === hash && prior.vector) {
            newChunks.push(prior);
          } else {
            newChunks.push({ path: rel, startLine: i + 1, endLine: Math.min(i + slice.length, i + CHUNK_LINES), hash, text: chunkText });
          }
          if (newChunks.length >= MAX_CHUNKS) break;
        }
        if (newChunks.length >= MAX_CHUNKS) break;
      }

      this.chunks = newChunks;

      // Probe embedding availability with the first not-yet-embedded chunk.
      const model = this.getEmbeddingModel();
      const toEmbed = this.chunks.filter((c) => !c.vector);
      if (toEmbed.length === 0) {
        this.embeddingsAvailable = this.chunks.some((c) => c.vector);
        onProgress?.('Index up to date.', 1);
        await this.saveCache();
        return;
      }

      const probe = await this.ollama.embed(model, toEmbed[0].text.slice(0, 2000));
      if (!probe) {
        this.embeddingsAvailable = false;
        onProgress?.(
          `No usable embedding model "${model}" found — @codebase will use keyword search instead. Run "ollama pull ${model}" to enable semantic search.`,
          1
        );
        await this.saveCache();
        return;
      }
      toEmbed[0].vector = probe;
      this.embeddingsAvailable = true;

      let done = 1;
      const rest = toEmbed.slice(1);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          if (token?.isCancellationRequested) return;
          const myIndex = cursor++;
          if (myIndex >= rest.length) return;
          const chunk = rest[myIndex];
          const vec = await this.ollama.embed(model, chunk.text.slice(0, 4000));
          if (vec) chunk.vector = vec;
          done++;
          if (done % 10 === 0 || done === toEmbed.length) {
            onProgress?.(`Embedded ${done}/${toEmbed.length} chunks…`, done / toEmbed.length);
          }
        }
      };
      await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, () => worker()));

      onProgress?.(`Indexed ${this.chunks.length} chunks (${done} embedded).`, 1);
      await this.saveCache();
    } finally {
      this.building = false;
    }
  }

  async search(query: string, k: number): Promise<{ path: string; snippet: string; score: number }[]> {
    if (!this.embeddingsAvailable || this.chunks.length === 0) {
      return keywordCodebaseSearch(this.workspaceRoot, query, k);
    }
    const qVec = await this.ollama.embed(this.getEmbeddingModel(), query);
    if (!qVec) return keywordCodebaseSearch(this.workspaceRoot, query, k);

    const scored = this.chunks
      .filter((c) => c.vector)
      .map((c) => ({ chunk: c, score: cosineSimilarity(qVec, c.vector!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return scored.map(({ chunk, score }) => ({
      path: `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
      snippet: chunk.text.length > 800 ? chunk.text.slice(0, 800) + '…' : chunk.text,
      score,
    }));
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
