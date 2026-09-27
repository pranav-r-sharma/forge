// ============================================================================
// 0.15.0: edit-engine fixes found by the multi-file end-to-end run (t03-add-function, 22 steps / FAIL on Ornith-9B).
//   1. reindentReplacement no longer forces a DELIBERATELY SHALLOWER definition onto the anchor's indent (it nested `def slugify` inside the old one).
//   2. detectDuplicateDefinitions: warns when an edit leaves a function defined inside itself or twice at top level.
//   3. echoEditedRegion: write_file shows the edited lines (numbered like read_file), removing the need for a verification read.
// The replay test drives the REAL writeFileTool through the exact edit sequence the model emitted.
// ============================================================================
import * as vscode from 'vscode';
import { writeFileTool, reindentReplacement, detectDuplicateDefinitions, echoEditedRegion } from '../../src/tools/fileTools';
import { ToolExecContext } from '../../src/agent/types';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

/** A stateful in-memory file: each accepted edit becomes what the next call sees, like the real PendingEditManager overlay. */
function fileCtx(initial: string) {
  const state = { text: initial };
  const ctx = {
    workspaceRoot: vscode.Uri.file('/ws'),
    cancellation: new vscode.CancellationTokenSource().token,
    proposeEdit: async (e: any) => { state.text = e.newText; return { id: 'e', applied: true }; },
    readEffective: async () => state.text,
  } as any as ToolExecContext;
  return { state, ctx };
}

const STRINGS = `"""Small string helpers."""


def title_case(text):
    """Capitalise the first letter of every word."""
    return " ".join(w[:1].upper() + w[1:].lower() for w in text.split(" "))


def count_words(text):
    """Number of whitespace-separated words."""
    return len(text.split())
`;

function testDedentedDefinitionIsNotForcedIn() {
  const file = 'def f(x):\n    a = 1\n    b = 2\n    return a + b\n';
  const anchorLine = 1; // "    a = 1"
  const r = reindentReplacement(file, anchorLine, true, 'def g(y):\n    return y\n');
  ok(!r.reindented && r.text === 'def g(y):\n    return y\n', 'Python: a replacement that starts a top-level `def` is left exactly as authored, not pushed inside the function it sits beside');
  const cls = reindentReplacement(file, anchorLine, true, 'class K:\n    pass\n');
  ok(!cls.reindented && cls.text.startsWith('class K:'), '`class` is treated the same way');
  const deco = reindentReplacement(file, anchorLine, true, '@cache\ndef g(y):\n    return y\n');
  ok(!deco.reindented && deco.text.startsWith('@cache'), 'a decorator-led definition too');
  const js = 'function outer() {\n  const a = 1;\n  return a;\n}\n';
  ok(!reindentReplacement(js, 1, true, 'function helper() {\n  return 2;\n}\n').reindented, 'JavaScript `function` at column 0 replacing an indented line is left alone');
  ok(!reindentReplacement(js, 1, true, 'export async function helper() {\n  return 2;\n}\n').reindented, 'including `export async function`');
  const rust = 'fn main() {\n    let a = 1;\n}\n';
  ok(!reindentReplacement(rust, 1, true, 'fn helper() {\n    ()\n}\n').reindented, 'and Rust `fn`');
}

function testOrdinaryReindentStillWorks() {
  const file = 'def f(x):\n    if x:\n        a = 1\n        b = 2\n    return 3\n';
  // the model dropped ALL indentation from a block of statements (not a definition): still corrected, as before
  const r = reindentReplacement(file, 2, true, 'a = 10\nb = 20');
  ok(r.reindented && r.text === '        a = 10\n        b = 20', `dropped indentation on ordinary statements is still remapped (got ${JSON.stringify(r.text)})`);
  // a definition at the SAME indent as the anchor is a normal nested/method definition: unchanged behaviour
  const cls = 'class C:\n    def a(self):\n        return 1\n';
  const r2 = reindentReplacement(cls, 1, true, '    def b(self):\n        return 2\n');
  ok(!r2.reindented && r2.text.includes('    def b'), 'a method at the anchor\'s own indent is untouched');
  // a definition indented DEEPER than the anchor keeps the old remapping path
  const r3 = reindentReplacement('def f():\n    x = 1\n', 1, true, '        def g():\n            return 1');
  ok(r3.reindented && r3.text.startsWith('    def g'), 'a definition indented deeper than the anchor is still normalised to the anchor');
}

function testDuplicateDefinitionAdvisory() {
  const nested = 'def slugify(text):\n    """doc"""\n    def slugify(text):\n        return text\n';
  const before = 'def slugify(text):\n    return text\n';
  const w = detectDuplicateDefinitions(before, nested);
  ok(!!w && /`slugify` is now defined INSIDE ITSELF/.test(w) && /ENTIRE old function/.test(w), `nested same-name definition introduced by an edit is flagged (got ${JSON.stringify(w && w.slice(0, 90))})`);
  const twice = 'def a():\n    return 1\n\n\ndef a():\n    return 2\n';
  const w2 = detectDuplicateDefinitions('def a():\n    return 1\n', twice);
  ok(!!w2 && /defined 2 times at the top level/.test(w2), 'a top-level function defined twice is flagged');
  ok(detectDuplicateDefinitions(nested, nested) === undefined, 'a problem that already existed before the edit is NOT re-reported (only what the edit introduced)');
  ok(detectDuplicateDefinitions(twice, twice) === undefined, 'same for a pre-existing duplicate');
  ok(detectDuplicateDefinitions(undefined, STRINGS) === undefined, 'a clean new file is fine');
  ok(detectDuplicateDefinitions('class C:\n    def a(self): pass\n', 'class C:\n    def a(self): pass\n    def b(self): pass\n') === undefined, 'ordinary methods are not flagged');
  const other = 'def outer():\n    def helper():\n        return 1\n    return helper()\n';
  ok(detectDuplicateDefinitions('def outer():\n    return 1\n', other) === undefined, 'a legitimately nested helper with a DIFFERENT name is fine');
  const separate = 'def a():\n    return 1\n\n\ndef b():\n    def a():\n        return 2\n    return a()\n';
  ok(detectDuplicateDefinitions('def a():\n    return 1\n\n\ndef b():\n    return 2\n', separate) === undefined, 'a nested function that merely shares a name with an UNRELATED top-level function is not "inside itself"');
  const js = 'function f(a) {\n  function f(b) {\n    return b;\n  }\n}\n';
  ok(!!detectDuplicateDefinitions('function f(a) {\n  return a;\n}\n', js), 'JavaScript nested same-name function is flagged too');
}

function testEcho() {
  const a = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n';
  const b = 'l1\nl2\nl3\nl4\nNEW\nl6\nl7\nl8\nl9\nl10\n';
  const e = echoEditedRegion('x.py', a, b)!;
  ok(/^Now x\.py \(lines 3-7 of 11\):/.test(e), `region is the changed line ±2 lines of context (got ${JSON.stringify(e.split('\n')[0])})`);
  ok(/\n5\| NEW/.test(e) && e.includes('3| l3') && e.includes('7| l7') && !e.includes('l8'), 'lines are numbered exactly like read_file (padded to the widest number) and the changed line is shown');
  const wide = echoEditedRegion('x', Array.from({ length: 120 }, (_, i) => `r${i}`).join('\n'), Array.from({ length: 120 }, (_, i) => (i === 98 ? 'CHANGED' : `r${i}`)).join('\n'))!;
  ok(wide.includes(' 99| CHANGED') && wide.includes('100| r99'), 'padding widens when line numbers reach three digits, like read_file');
  ok(echoEditedRegion('x', a, a) === undefined, 'no change → no echo');
  const big = echoEditedRegion('x', 'a\nb\n', 'a\n' + Array.from({ length: 100 }, (_, i) => `n${i}`).join('\n') + '\nb\n', 30)!;
  ok(big.split('\n').length <= 33 && /lines of the change not shown/.test(big), 'a large change is capped with an elision note');
  const del = echoEditedRegion('x', 'a\nb\nc\nd\n', 'a\nd\n')!;
  ok(/lines 1-2 of 3/.test(del) || /lines 1-3 of 3/.test(del), 'a pure deletion shows the surrounding lines');
  const top = echoEditedRegion('x', 'a\nb\n', 'z\nb\n')!;
  ok(/lines 1-3 of 3/.test(top) && top.includes('1| z'), 'an edit at the very top does not underflow (a trailing newline counts as a last empty line, same as read_file)');
  ok(echoEditedRegion('x', 'a\n', 'a\nb\n')!.includes('2| b'), 'appending shows the new last line');
}

async function testWriteResultCarriesEchoAndWarnings() {
  const { ctx } = fileCtx(STRINGS);
  const r = await writeFileTool({ path: 'strings.py', search: 'def count_words(text):', replace: 'def slugify(text):\n    return text.lower()\n\n\ndef count_words(text):' }, ctx);
  ok(r.ok && /^Updated strings\.py\./.test(r.content) && /Now strings\.py \(lines \d+-\d+ of \d+\):/.test(r.content) && r.content.includes('def slugify(text):'), 'a successful edit reports the resulting lines, numbered, in the same result');
  const created = await writeFileTool({ path: 'new.py', content: 'x = 1\n' }, fileCtx('').ctx);
  const c2 = await writeFileTool({ path: 'new.py', content: 'x = 1\n' }, { ...fileCtx('x').ctx, readEffective: async () => undefined } as any);
  ok(c2.ok && !/Now new\.py/.test(c2.content), 'creating a new file does not echo (the model just wrote every line)');
}

async function testReplayOfTheFailingRun() {
  // The exact sequence from the failed t03 run (see _devtools/e2e/results/2026-09-27-smoke-t03-add-function.messages.json).
  const { state, ctx } = fileCtx(STRINGS);
  const r3 = await writeFileTool({ path: 'strings.py', search: 'def count_words(text):', replace: 'def slugify(text):\n    """Lowercase text, collapse non-alphanumeric runs to hyphens, strip edge hyphens."""\n    slug = "".join(ch if ch.isalnum() else "-" for ch in text.lower())\n    return "-".join(slug.split("-"))\n\n\ndef count_words(text):' }, ctx);
  ok(r3.ok && (state.text.match(/def slugify/g) || []).length === 1, 'step 3 (add slugify before count_words) works');
  // step 8: replace the two BODY lines with a whole new top-level def (the edit that used to nest it)
  const r8 = await writeFileTool({ path: 'strings.py', search: '    slug = "".join(ch if ch.isalnum() else "-" for ch in text.lower())\n    return "-".join(slug.split("-"))', replace: 'def slugify(text):\n    """Lowercase text, collapse non-alphanumeric runs to hyphens, strip edge hyphens."""\n    slug = "".join(ch if ch.isalnum() else "-" for ch in text.strip().lower())\n    return "-".join(slug.split("-"))' }, ctx);
  ok(r8.ok && !/automatically remapped/.test(r8.content), 'step 8: the model\'s column-0 `def` is NOT silently re-indented (that was the trap)');
  const before = state.text;
  const nestedDefs = (before.match(/^\s+def slugify/gm) || []).length;
  ok(nestedDefs === 0 || /INSIDE ITSELF|defined 2 times/.test(r8.content), `the file is not silently corrupted: either no nested def, or the result warns about it (nested=${nestedDefs})`);
  ok(/defined 2 times at the top level|INSIDE ITSELF/.test(r8.content) || (before.match(/^def slugify/gm) || []).length === 1, 'and if a duplicate is left behind, the write result says so immediately');
  console.log('   (info) result tail:', JSON.stringify(r8.content.slice(-330)));
}

async function main() {
  testDedentedDefinitionIsNotForcedIn();
  testOrdinaryReindentStillWorks();
  testDuplicateDefinitionAdvisory();
  testEcho();
  await testWriteResultCarriesEchoAndWarnings();
  await testReplayOfTheFailingRun();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 edit tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 edit tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_edits.ts:', err); process.exit(1); });
