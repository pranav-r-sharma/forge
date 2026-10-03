// search_code grep upgrade (v0.15.0-work, bridge 2026-10-03)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { searchCodeTool } from '../../src/tools/searchTools';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'grep');

function setAppRoot(p: string) {
  const v = require('vscode') as { __setAppRoot?: (s: string) => void };
  v.__setAppRoot?.(p);
}

function makeWorkspace(): { root: string; ctx: any } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-grep-'));
  fs.cpSync(FIXTURE_SRC, root, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'skip'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'skip', 'secret.ts'), 'needle-hidden');
  fs.writeFileSync(path.join(root, 'other.txt'), 'needle-plain');
  (vscode.workspace as any).__setWorkspaceRoot(root);
  const ctx = {
    workspaceRoot: vscode.Uri.file(root),
    cancellation: new vscode.CancellationTokenSource().token,
    codebaseSearch: async () => [],
  };
  return { root, ctx };
}

function matchLines(content: string): string[] {
  return content
    .split('\n')
    .filter((l) => /:\d+:/.test(l))
    .map((l) => l.replace(/: .*$/, ''));
}

async function runTests() {
  const { root, ctx } = makeWorkspace();
  setAppRoot('');

  const basic = await searchCodeTool({ query: 'find-me-here' }, ctx);
  ok(basic.ok && /sample\.ts:\d+:/.test(basic.content), 'literal query finds sample.ts');
  ok(/match\(es\) in/.test(basic.content), 'lines mode header');

  const patternAlias = await searchCodeTool({ pattern: 'TARGET' }, ctx);
  ok(patternAlias.ok && /sample\.py/.test(patternAlias.content), 'pattern alias works');

  const slash = await searchCodeTool({ query: '/find-me/i' }, ctx);
  ok(slash.ok && /find-me-here/.test(slash.content), '/regex/flags backward compat');

  const regexBad = await searchCodeTool({ query: '(unclosed', regex: true }, ctx);
  ok(!regexBad.ok && /invalid regex/i.test(regexBad.content), 'bad regex with regex:true errors clearly');

  const caseSens = await searchCodeTool({ query: 'MARKER', caseSensitive: true }, ctx);
  ok(caseSens.ok && /doc\.md/.test(caseSens.content), 'caseSensitive finds MARKER in md');

  const whole = await searchCodeTool({ query: 'alpha', wholeWord: true }, ctx);
  ok(whole.ok && !whole.content.includes('alphaBeta'), 'wholeWord does not match alpha inside alphaBeta');

  const filesMode = await searchCodeTool({ query: 'needle', mode: 'files' }, ctx);
  ok(filesMode.ok && /file\(s\) matching/.test(filesMode.content) && filesMode.content.includes('sample.ts'), 'files mode lists paths');

  const countMode = await searchCodeTool({ query: 'needle', mode: 'count' }, ctx);
  ok(countMode.ok && /sample\.ts: \d+/.test(countMode.content), 'count mode per-file counts');

  const include = await searchCodeTool({ query: 'needle', include: '**/*.ts' }, ctx);
  ok(include.ok && include.content.includes('sample.ts') && !include.content.includes('other.txt'), 'include glob restricts to ts');

  const exclude = await searchCodeTool({ query: 'needle', include: '**/*', exclude: 'other.txt' }, ctx);
  ok(exclude.ok && !exclude.content.includes('other.txt'), 'exclude drops other.txt');

  const subPath = await searchCodeTool({ query: 'TARGET', path: 'sample.py' }, ctx);
  ok(subPath.ok && subPath.content.includes('sample.py') && !subPath.content.includes('sample.ts'), 'path to single file');

  const outside = await searchCodeTool({ query: 'x', path: '../../etc/passwd' }, ctx);
  ok(!outside.ok && /outside the workspace/i.test(outside.content), 'path escape rejected');

  const ctxLines = await searchCodeTool({ query: 'MARKER', path: 'doc.md', context: 1 }, ctx);
  ok(ctxLines.ok && ctxLines.content.split('\n').filter((l) => l.includes('doc.md')).length >= 2, 'context adds neighbor lines');

  const maxR = await searchCodeTool({ query: 'e', maxResults: 2 }, ctx);
  ok(maxR.ok && /truncated at 2/.test(maxR.content), 'maxResults truncation note');

  const globLegacy = await searchCodeTool({ query: 'zzz-no-match', glob: '**/*.ts' }, ctx);
  ok(globLegacy.ok && /under \*\*\/\*\.ts/.test(globLegacy.content), 'glob still works for no-match message');

  const extractPy = await searchCodeTool({
    query: 'TARGET',
    mode: 'extract',
    path: 'sample.py',
  }, ctx);
  ok(extractPy.ok && /match at sample\.py/.test(extractPy.content) && /def inner/.test(extractPy.content), 'extract mode on .py block');

  const extractMd = await searchCodeTool({
    query: 'MARKER',
    mode: 'extract',
    path: 'doc.md',
  }, ctx);
  ok(extractMd.ok && /Section Alpha/.test(extractMd.content), 'extract mode on .md heading section');

  const extractTs = await searchCodeTool({
    query: 'needle',
    mode: 'extract',
    path: 'sample.ts',
  }, ctx);
  ok(extractTs.ok && /export const needle/.test(extractTs.content), 'extract mode on .ts');

  const extractNoPath = await searchCodeTool({ query: 'x', mode: 'extract' }, ctx);
  ok(!extractNoPath.ok && /requires/.test(extractNoPath.content), 'extract without path errors');

  const hidden = await searchCodeTool({ query: 'needle-hidden' }, ctx);
  ok(hidden.ok && !hidden.content.includes('node_modules'), 'default excludes skip node_modules');

  // JS vs rg parity when Cursor bundles rg
  const cursorApp = '/Applications/Cursor.app/Contents/Resources/app';
  const rgPath = path.join(cursorApp, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
  if (fs.existsSync(rgPath)) {
    setAppRoot(cursorApp);
    const viaRg = await searchCodeTool({ query: 'find-me-here' }, ctx);
    setAppRoot('');
    const viaJs = await searchCodeTool({ query: 'find-me-here' }, ctx);
    ok(viaRg.ok && viaJs.ok, 'rg and js engines both succeed');
    const rgLines = matchLines(viaRg.content).sort();
    const jsLines = matchLines(viaJs.content).sort();
    ok(rgLines.join('|') === jsLines.join('|'), 'rg/js parity on match lines');
  } else {
    console.log('ok - (skip) rg parity — bundled rg not found on this machine');
    passed++;
  }

  // Review fixes (2026-10-03)
  fs.writeFileSync(path.join(root, 'Case.txt'), 'FooBar here\nfoobar there\n');
  const slashCase = await searchCodeTool({ query: '/FooBar/', path: 'Case.txt' }, ctx);
  ok(slashCase.ok && /^1 match/.test(slashCase.content), '/re/ without i stays case-sensitive (pre-upgrade behaviour)');
  const slashCaseI = await searchCodeTool({ query: '/FooBar/i', path: 'Case.txt' }, ctx);
  ok(slashCaseI.ok && /^2 match/.test(slashCaseI.content), '/re/i is case-insensitive');
  const plainCase = await searchCodeTool({ query: 'FooBar', path: 'Case.txt' }, ctx);
  ok(plainCase.ok && /^2 match/.test(plainCase.content), 'plain literal stays case-insensitive by default');

  const multiInc = await searchCodeTool({ query: 'needle', include: ['**/*.ts', '**/*.md'] }, ctx);
  ok(multiInc.ok && !multiInc.content.includes('other.txt'), 'several include globs: JS scan honours them (no other.txt)');

  fs.writeFileSync(path.join(root, 'ctx.txt'), 'a\nhit1\nhit2\nb\n');
  const overlap = await searchCodeTool({ query: 'hit', path: 'ctx.txt', context: 1 }, ctx);
  const ovLines = overlap.content.split('\n').filter((l) => l.startsWith('ctx.txt:'));
  ok(ovLines.length === 4 && new Set(ovLines).size === 4, `overlapping context lines are not duplicated (got ${ovLines.length})`);

  fs.writeFileSync(path.join(root, 'brace.ts'), 'function keep() {\n  const x = 1;\n  return x;\n}\nconst after = 2;\n');
  const brace = await searchCodeTool({ query: 'function keep', mode: 'extract', path: 'brace.ts' }, ctx);
  ok(brace.ok && /4: }/.test(brace.content) && !/after/.test(brace.content), 'extract includes the closing brace, not the next statement');

  const rgApp = ['/Applications/Visual Studio Code.app/Contents/Resources/app', '/Applications/Cursor.app/Contents/Resources/app'].find((a) =>
    fs.existsSync(path.join(a, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg')),
  );
  if (rgApp) {
    const cases: Record<string, any>[] = [
      { query: 'needle' },
      { query: 'hit', path: 'ctx.txt', context: 1 },
      { query: 'needle', include: ['**/*.ts', '**/*.md'] },
      { query: 'alpha', wholeWord: true },
      { query: '/FooBar/', path: 'Case.txt' },
      { query: 'needle', mode: 'count' },
    ];
    for (const c of cases) {
      setAppRoot(rgApp);
      const a = await searchCodeTool(c, ctx);
      setAppRoot('');
      const b = await searchCodeTool(c, ctx);
      const norm = (t: string) => t.split('\n').slice(1).sort().join('|');
      ok(a.ok && b.ok && norm(a.content) === norm(b.content) && a.content.split('\n')[0] === b.content.split('\n')[0], `rg/js parity: ${JSON.stringify(c)}`);
    }
    setAppRoot(rgApp);
    const look = await searchCodeTool({ query: 'needle(?= =)', regex: true }, ctx);
    setAppRoot('');
    ok(look.ok && /sample\.ts/.test(look.content), 'look-ahead (rg cannot parse) falls back to the JS engine instead of erroring');
  } else {
    console.log('ok - (skip) rg parity set — no bundled rg on this machine');
    passed++;
  }

  fs.rmSync(root, { recursive: true, force: true });
  setAppRoot('');
  (vscode.workspace as any).__setWorkspaceRoot(undefined);
}

runTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
