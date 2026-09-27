import * as vscode from 'vscode';
import { LlmProvider } from '../llm/provider';
import { isIgnoredDir, looksBinary, toRelative } from '../util/paths';
import { sha1 } from '../util/hash';
import { keywordCodebaseSearch } from './keywordSearch';
import { cosineSimilarity } from '../util/vector';
import { chunkFileStructurally } from './chunker';
import { buildImportGraph } from './importGraph';
import { logger } from '../util/logger';

const MAX_FILES = 3000;
const MAX_CHUNKS = 4000;
const MAX_FILE_BYTES_FOR_INDEX = 512 * 1024;
const EMBED_CONCURRENCY = 4;

/** Additive score nudges for retrieval weighting — see WorkspaceIndex.search()'s doc comment. Deliberately small relative to typical cosine-similarity gaps (roughly 0-1) so an open-but-irrelevant file can never outrank a genuinely on-topic one; they only break near-ties or nudge a borderline-relevant-but-currently-relevant-to-you chunk over one that's topically similar but in a file you haven't touched in a while. */
const OPEN_TAB_BOOST = 0.06;
const RECENTLY_EDITED_BOOST = 0.04;
const RECENTLY_EDITED_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
/** How many extra "pulled in via import" snippets search() may append beyond the requested k — see the import-graph section of search()'s doc comment. */
const MAX_IMPORT_PULLED_IN = 2;

interface IndexedChunk {
  path: string;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
  vector?: number[];
}

interface IndexCacheFile {
  version: 2;
  embeddingModel: string;
  chunks: IndexedChunk[];
}

/**
 * A lightweight semantic index over the open workspace: chunks text files by
 * detected declaration boundaries where possible (see indexing/chunker.ts),
 * embeds each chunk with the configured Ollama embedding model, and answers
 * `search()` with cosine-similarity ranking, nudged by a couple of cheap
 * relevance signals (open tabs, recent edits) and augmented with directly-
 * imported files. Falls back to plain keyword search automatically if no
 * embedding model is installed/reachable — @codebase / search_codebase
 * always returns *something* useful either way.
 *
 * `getOpenPaths` is injected (rather than read from `vscode.window.tabGroups`
 * directly) so this class stays testable without a real editor UI — see
 * extension.ts for the real wiring and _devtools/runtime_test/test_v11.ts for
 * the fake used in tests.
 */
export class WorkspaceIndex {
  private chunks: IndexedChunk[] = [];
  private embeddingsAvailable = false;
  private building = false;
  private cacheUri: vscode.Uri | undefined;
  /** path -> resolved import paths, rebuilt on every build() — see indexing/importGraph.ts. */
  private importGraph = new Map<string, string[]>();
  /** relPath -> last-touched timestamp (ms) — fed by markRecentlyTouched(), used for the recency boost in search(). Deliberately in-memory/session-scoped, not persisted: "recently touched" is only meaningful within the current working session. */
  private recentlyTouched = new Map<string, number>();

  constructor(
    private ollama: LlmProvider,
    private workspaceRoot: vscode.Uri,
    private storageUri: vscode.Uri | undefined,
    private getEmbeddingModel: () => string,
    private getOpenPaths: () => Set<string> = () => new Set()
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

  /** Records that `relPath` was just written (by the agent or the user) — see RECENTLY_EDITED_BOOST. Called from extension.ts via PendingEditManager.onBeforeWrite, so it fires for every write regardless of which chat tab made it. */
  markRecentlyTouched(relPath: string) {
    this.recentlyTouched.set(relPath, Date.now());
  }

  async loadCache(): Promise<void> {
    if (!this.cacheUri) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as IndexCacheFile;
      if (data.version === 2 && data.embeddingModel === this.getEmbeddingModel()) {
        this.chunks = data.chunks;
        this.embeddingsAvailable = this.chunks.some((c) => c.vector);
        this.importGraph = buildImportGraph(this.filesFromChunks());
      }
    } catch {
      /* no cache yet, unreadable, or an old (pre-structural-chunking) cache version — that's fine, build() will create/replace it. */
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheUri) return;
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri!);
      const data: IndexCacheFile = { version: 2, embeddingModel: this.getEmbeddingModel(), chunks: this.chunks };
      await vscode.workspace.fs.writeFile(this.cacheUri, Buffer.from(JSON.stringify(data), 'utf8'));
    } catch (err) {
      logger.warn('Failed to save workspace index cache', String(err));
    }
  }

  /** Reassembles each file's full text from its ordered chunks — good enough for import-graph extraction (which only needs to see the top of the file) without re-reading every file from disk again. */
  private filesFromChunks(): { path: string; text: string }[] {
    const byPath = new Map<string, IndexedChunk[]>();
    for (const c of this.chunks) {
      const list = byPath.get(c.path) || [];
      list.push(c);
      byPath.set(c.path, list);
    }
    return [...byPath.entries()].map(([path, chunks]) => ({
      path,
      text: chunks
        .sort((a, b) => a.startLine - b.startLine)
        .map((c) => c.text)
        .join('\n'),
    }));
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
      const filesForImportGraph: { path: string; text: string }[] = [];

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

        filesForImportGraph.push({ path: rel, text });

        // Item "tree-sitter based chunking so context boundaries respect
        // function/class scope": chunkFileStructurally() prefers to cut at a
        // detected declaration boundary instead of an arbitrary line count —
        // see indexing/chunker.ts for why this is a heuristic, not a real
        // parser, and why that's a deliberate scoping choice.
        const pieces = chunkFileStructurally(text);
        for (const piece of pieces) {
          if (!piece.text.trim()) continue;
          const hash = sha1(piece.text);
          const key = `${rel}#${piece.startLine}`;
          const prior = priorByKey.get(key);
          if (prior && prior.hash === hash && prior.vector) {
            newChunks.push(prior);
          } else {
            newChunks.push({ path: rel, startLine: piece.startLine, endLine: piece.endLine, hash, text: piece.text });
          }
          if (newChunks.length >= MAX_CHUNKS) break;
        }
        if (newChunks.length >= MAX_CHUNKS) break;
      }

      this.chunks = newChunks;
      this.importGraph = buildImportGraph(filesForImportGraph);

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
          `No usable embedding model "${model}" found — @codebase will use keyword search instead. Run "ollama pull ${model}" to enable semantic search (for code-heavy repos, a code-tuned embedding model such as "ollama pull embeddinggemma" tends to outperform a general text-embedding model like the default "nomic-embed-text" — see README → "Semantic search over your codebase").`,
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

  /**
   * Ranks chunks by cosine similarity to the query, then nudges that ranking
   * with two cheap, dependency-free relevance signals before picking the
   * top `k`:
   *
   * - **Open-tab weighting**: a chunk in a file you currently have open gets
   *   a small boost — you're almost certainly working on or near it right
   *   now, which plain semantic similarity to the query text alone can't see.
   * - **Recently-edited weighting**: a chunk in a file touched (by the agent
   *   or you) in the last 30 minutes gets a smaller boost, for the same
   *   reason applied to "recent" rather than "currently open."
   *
   * Both boosts are small and additive (see OPEN_TAB_BOOST/
   * RECENTLY_EDITED_BOOST) specifically so they can only break ties or nudge
   * a borderline result — they can never make an irrelevant chunk in an open
   * tab outrank a strongly relevant one elsewhere.
   *
   * **Import-graph augmentation** ("if file A imports B, pull relevant bits
   * of B"): once the top-`k` list is settled, this looks at the single
   * highest-scoring hit's resolved imports (see indexing/importGraph.ts) and,
   * for up to MAX_IMPORT_PULLED_IN of them, appends that imported file's own
   * best-matching chunk — clearly labeled — if it isn't already present.
   * This is why you can ask a question that's really "answered" by a helper
   * a file imports, without the query text itself resembling that helper.
   */
  async search(query: string, k: number): Promise<{ path: string; snippet: string; score: number }[]> {
    if (!this.embeddingsAvailable || this.chunks.length === 0) {
      return keywordCodebaseSearch(this.workspaceRoot, query, k);
    }
    const qVec = await this.ollama.embed(this.getEmbeddingModel(), query);
    if (!qVec) return keywordCodebaseSearch(this.workspaceRoot, query, k);

    const openPaths = this.safeGetOpenPaths();
    const now = Date.now();
    const boosted = this.chunks
      .filter((c) => c.vector)
      .map((c) => {
        const base = cosineSimilarity(qVec, c.vector!);
        let boost = 0;
        if (openPaths.has(c.path)) boost += OPEN_TAB_BOOST;
        const touchedAt = this.recentlyTouched.get(c.path);
        if (touchedAt !== undefined && now - touchedAt < RECENTLY_EDITED_WINDOW_MS) boost += RECENTLY_EDITED_BOOST;
        return { chunk: c, baseScore: base, score: base + boost };
      })
      .sort((a, b) => b.score - a.score);

    const top = boosted.slice(0, k);
    const results = top.map(({ chunk, score }) => ({
      path: `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
      snippet: truncateSnippet(chunk.text),
      score,
    }));

    if (top.length > 0) {
      const seenPaths = new Set(top.map((t) => t.chunk.path));
      const topHitPath = top[0].chunk.path;
      const importedPaths = (this.importGraph.get(topHitPath) || []).filter((p) => !seenPaths.has(p));
      for (const importedPath of importedPaths.slice(0, MAX_IMPORT_PULLED_IN)) {
        const candidates = boosted.filter((b) => b.chunk.path === importedPath);
        if (candidates.length === 0) continue;
        candidates.sort((a, b) => b.baseScore - a.baseScore);
        const best = candidates[0];
        seenPaths.add(importedPath);
        results.push({
          path: `${best.chunk.path}:${best.chunk.startLine}-${best.chunk.endLine}`,
          snippet: `[Pulled in because ${topHitPath} imports this file]\n${truncateSnippet(best.chunk.text)}`,
          score: best.baseScore,
        });
      }
    }

    return results;
  }

  private safeGetOpenPaths(): Set<string> {
    try {
      return this.getOpenPaths();
    } catch (err) {
      logger.warn('getOpenPaths() failed', String(err));
      return new Set();
    }
  }
}

function truncateSnippet(text: string): string {
  return text.length > 800 ? text.slice(0, 800) + '…' : text;
}
