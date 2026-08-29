/**
 * Dependency-free, boundary-aware chunker for `search_codebase`'s indexer.
 *
 * Prior behavior (through 0.10.0) sliced every file into fixed 120-line
 * windows with no regard for what was actually in them — a chunk could start
 * mid-function-body and end mid-signature of the next one, which hurts
 * embedding quality (the chunk's vector represents two unrelated fragments
 * glued together) and makes returned snippets awkward to read.
 *
 * The "correct" fix here is a real per-language parser — tree-sitter is the
 * standard tool for exactly this. Forge deliberately does not depend on it:
 * tree-sitter ships as native (or WASM) per-language grammars, which breaks
 * the project's zero-runtime-npm-dependency constraint (see README/CHANGELOG
 * — this is the same tradeoff that scoped memory retrieval down to a
 * keyword-overlap heuristic instead of a real embedding pipeline in 0.10.0).
 * Instead this uses a cheap heuristic: scan for lines that *look like* the
 * start of a top-level declaration (function/class/etc, allowing for
 * decorators and export/visibility keywords) across several common language
 * families, and prefer to cut chunks there instead of at an arbitrary line
 * count. It is NOT a parser — no brace/indent tracking, no string/comment
 * awareness, no per-language grammar — so it will occasionally cut in the
 * wrong place (e.g. a line inside a multi-line string that happens to match
 * the pattern). That's an acceptable failure mode for a *chunking* boundary
 * (worst case: same as the old fixed-window behavior for that one chunk) —
 * it does not affect correctness of anything else in the extension.
 */

export interface CodeChunk {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  text: string;
}

/** Once an accumulating chunk hits this many lines, it's force-closed even mid-declaration — the same hard cap the old fixed-window chunker used, so a single huge function/file never produces an unboundedly large chunk. */
const DEFAULT_MAX_LINES = 160;
/** Never close a chunk at a boundary before it has at least this many lines — otherwise a file with many short top-level declarations (e.g. a barrel/re-export file) would produce a flood of tiny, low-context chunks. */
const DEFAULT_MIN_LINES = 20;

/**
 * Matches a line that plausibly starts a new top-level declaration in one of
 * several common language families: JS/TS (function/class/interface/type/
 * const-arrow/export/decorator), Python (def/class/decorator), Go (func),
 * Rust (fn/struct/impl/trait), Java/C#/C++ (visibility modifiers + a
 * function-or-class-looking line), and a bare decorator/attribute line
 * (`@Something`, `#[derive(...)]`) which should stay attached to the
 * declaration it precedes rather than splitting from it.
 */
const BOUNDARY_RE =
  /^[ \t]*(?:@\w[\w.]*(?:\(.*\))?\s*$|#\[[^\]]*\]\s*$|(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|abstract\s+|final\s+|async\s+|pub\s+)*(?:function\b|class\b|interface\b|enum\b|struct\b|impl\b|trait\b|namespace\b|module\b|def\s+\w|fn\s+\w|func\s+\w|type\s+\w+\s*=|const\s+\w+\s*[:=]\s*(?:async\s*)?\(|module\.exports\s*=))/;

/** True if `line` looks like a top-level (not deeply nested) declaration start — indentation is capped low so we don't treat a line inside a function body as a boundary just because it happens to match the keyword pattern. */
function isBoundaryLine(line: string): boolean {
  const indent = line.match(/^[ \t]*/)?.[0]?.length ?? 0;
  if (indent > 2) return false;
  return BOUNDARY_RE.test(line);
}

/**
 * Splits `text` into chunks that prefer to break at a detected top-level
 * declaration boundary rather than an arbitrary line count. Falls back to
 * the old fixed-window behavior wherever no boundary is found within
 * `maxLines` (a minified file, a file in an unrecognized language, a single
 * function longer than the cap) — so this strictly never does worse than
 * 0.10.0's chunker, only better when a boundary is actually detectable.
 */
export function chunkFileStructurally(text: string, maxLines = DEFAULT_MAX_LINES, minLines = DEFAULT_MIN_LINES): CodeChunk[] {
  const lines = text.split('\n');
  if (lines.length === 0) return [];

  const chunks: CodeChunk[] = [];
  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    const sizeSoFar = i - start;
    if (sizeSoFar >= maxLines) {
      chunks.push(makeChunk(lines, start, i));
      start = i;
      continue;
    }
    if (sizeSoFar >= minLines && isBoundaryLine(lines[i])) {
      chunks.push(makeChunk(lines, start, i));
      start = i;
    }
  }
  if (start < lines.length) chunks.push(makeChunk(lines, start, lines.length));
  return chunks;
}

function makeChunk(lines: string[], start: number, end: number): CodeChunk {
  return { startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') };
}
