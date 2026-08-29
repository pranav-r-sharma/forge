/**
 * Lightweight, regex-based import extraction + resolution for
 * `search_codebase`'s "pull in what a top hit imports" step.
 *
 * This is deliberately NOT real module resolution: no tsconfig `paths`, no
 * node_modules walking, no Python package/namespace resolution, no build-tool
 * awareness. It only ever resolves relative specifiers (`./foo`, `../bar/baz`)
 * against the set of files Forge already has indexed, using plain path-join
 * arithmetic and a handful of common extension/index-file guesses. A bare
 * specifier (an npm package name, an absolute Python module path) is left
 * unresolved on purpose — "which of MY OWN files does this file pull in" is
 * the useful question for retrieval augmentation; "does this resolve to some
 * package in node_modules" is not (node_modules isn't indexed at all).
 */

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\w*${}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g, // JS/TS: import x from '...' / import '...'
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // CommonJS require('...')
  /^\s*from\s+([.\w]+)\s+import\b/gm, // Python: from .foo import bar / from x.y import z
  /^\s*import\s+([.\w]+)\s*$/gm, // Python: import x.y (bare, module-level only)
];

/** Every distinct import specifier found in `text`, exactly as written (not yet resolved to a path). */
export function extractImportSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[1]) specs.add(m[1]);
    }
  }
  return [...specs];
}

/**
 * Resolves a relative JS/TS-style specifier against `fromPath` (the
 * workspace-relative path of the file containing the import), returning a
 * path from `knownPaths` if one matches, else undefined. Bare specifiers
 * (no leading `.`) are always left unresolved — see the module doc comment.
 */
export function resolveImportPath(spec: string, fromPath: string, knownPaths: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const joined = normalizeRelativePath(fromDir, spec);
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}.py`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.js`,
  ];
  return candidates.find((c) => knownPaths.has(c));
}

function normalizeRelativePath(fromDir: string, spec: string): string {
  const parts = (fromDir ? fromDir.split('/') : []).concat(spec.split('/'));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Builds a `path -> resolved-import-paths` map for every indexed file, given
 * its full text. Computed once per `build()` (imports are almost always
 * declared near the top of a file, so this is cheap relative to embedding),
 * not per-chunk — a chunk pulled in "because the top hit imports it" pulls
 * from the *whole* imported file's chunks, not just its import statements.
 */
export function buildImportGraph(files: { path: string; text: string }[]): Map<string, string[]> {
  const knownPaths = new Set(files.map((f) => f.path));
  const graph = new Map<string, string[]>();
  for (const f of files) {
    const specs = extractImportSpecifiers(f.text);
    const resolved = specs
      .map((s) => resolveImportPath(s, f.path, knownPaths))
      .filter((p): p is string => !!p && p !== f.path);
    if (resolved.length > 0) graph.set(f.path, [...new Set(resolved)]);
  }
  return graph;
}
