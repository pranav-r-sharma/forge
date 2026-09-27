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

// ============================================================================
// Regression: found live on 2026-09-27 (full-suite rerun, t04/t06). A search/replace whose "search" text omits a line's leading whitespace (the
// model is not changing the indent, just the code) used to get that indent ADDED A SECOND TIME on top of what was already physically in the file —
// e.g. "    return x" -> search "return x" -> replace "return y" produced "        return y" (8 spaces), an IndentationError in Python.
// ============================================================================
async function testDoesNotDoubleIndentWhenSearchOmitsLeadingWhitespace() {
  const file = 'def revenue(orders):\n    """Sum."""\n    return round(sum(pricing.calc_tot(lines) for lines in orders), 2)\n';
  const { state, ctx } = fileCtx(file);
  const r = await writeFileTool({ path: 'r.py', search: 'return round(sum(pricing.calc_tot(lines) for lines in orders), 2)', replace: 'return round(sum(pricing.calculate_total(lines) for lines in orders), 2)' }, ctx);
  ok(r.ok, 'the edit succeeds');
  const editedLine = state.text.split('\n')[2];
  ok(editedLine === '    return round(sum(pricing.calculate_total(lines) for lines in orders), 2)', `the file's own indentation is kept EXACTLY as it was — not doubled (got ${JSON.stringify(editedLine)})`);
  ok(/^\s{5,}/.test(editedLine) === false, 'never more indentation than the file actually has');
}

async function testDoubleIndentAcrossIndentStyles() {
  // tabs
  const tabFile = 'function f() {\n\treturn 1;\n}\n';
  const t1 = fileCtx(tabFile);
  await writeFileTool({ path: 'f.ts', search: 'return 1;', replace: 'return 2;' }, t1.ctx);
  ok(t1.state.text === 'function f() {\n\treturn 2;\n}\n', `tab-indented files: no extra tab added (got ${JSON.stringify(t1.state.text)})`);
  // deep nesting (8 spaces)
  const deep = 'if a:\n    if b:\n        x = 1\n';
  const t2 = fileCtx(deep);
  await writeFileTool({ path: 'd.py', search: 'x = 1', replace: 'x = 2' }, t2.ctx);
  ok(t2.state.text === 'if a:\n    if b:\n        x = 2\n', `deep (8-space) nesting is preserved exactly, not made 12 (got ${JSON.stringify(t2.state.text)})`);
  // multi-line replace where only the first line omits the leading indent
  const multi = 'def f():\n    a = 1\n    b = 2\n';
  const t3 = fileCtx(multi);
  await writeFileTool({ path: 'm.py', search: 'a = 1\n    b = 2', replace: 'a = 10\n    b = 20' }, t3.ctx);
  ok(t3.state.text === 'def f():\n    a = 10\n    b = 20\n', 'a multi-line search whose first line omits the indent but whose later lines include it is not doubled either');
  // the "edits" (multi-edit) path uses the same function — must be fixed there too
  const e = fileCtx('def f():\n    x = 1\n    y = 2\n');
  const re = await writeFileTool({ path: 'e.py', edits: [{ search: 'x = 1', replace: 'x = 10' }, { search: 'y = 2', replace: 'y = 20' }] }, e.ctx);
  ok(re.ok && e.state.text === 'def f():\n    x = 10\n    y = 20\n', 'the edits[] (multi-edit) path is fixed too, not just single search/replace');
  // a search that DOES include its own leading whitespace still gets normal reindent treatment (the fix must not disable that)
  const norm = fileCtx('def f():\n\tx = 1\n'); // file is tab-indented
  await writeFileTool({ path: 'n.py', search: '    x = 1', replace: '    x = 2' }, norm.ctx); // model wrote spaces, matching the file's tab depth
  ok(norm.state.text === 'def f():\n\tx = 2\n', `a search that already includes indentation is still remapped onto the file's real style (unrelated code path, must stay working) — got ${JSON.stringify(norm.state.text)}`);
  // a match truly at column 0 (no indent at all) is unaffected
  const col0 = fileCtx('x = 1\ny = 2\n');
  await writeFileTool({ path: 'c.py', search: 'x = 1', replace: 'x = 100' }, col0.ctx);
  ok(col0.state.text === 'x = 100\ny = 2\n', 'a column-0 match (no indentation at all) is unaffected');
}

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

const RENAME = `from .pricing import calc_tot


def render(order_id, lines):
    total = calc_tot(lines)
    other = calc_tot([])
    return f"{order_id}: {total} {other}"
`;

async function testMultiEdit() {
  // several edits, one call, applied in order
  const { state, ctx } = fileCtx(RENAME);
  const r = await writeFileTool({ path: 'inv.py', edits: [
    { search: 'from .pricing import calc_tot', replace: 'from .pricing import calculate_total' },
    { search: 'total = calc_tot(lines)', replace: 'total = calculate_total(lines)' },
    { search: 'other = calc_tot([])', replace: 'other = calculate_total([])' },
  ] }, ctx);
  ok(r.ok && !state.text.includes('calc_tot') && (state.text.match(/calculate_total/g) || []).length === 3, 'three edits in ONE call all land');
  ok(/Applied 3 edits in order\./.test(r.content) && /Now inv\.py \(lines 1-\d+ of \d+\):/.test(r.content), 'the result says so and echoes the combined changed region once');

  // later edits see earlier ones (sequential semantics)
  const seq = fileCtx('a = 1\n');
  const rs = await writeFileTool({ path: 'x.py', edits: [{ search: 'a = 1', replace: 'a = 2' }, { search: 'a = 2', replace: 'a = 3' }] }, seq.ctx);
  ok(rs.ok && seq.state.text === 'a = 3\n', 'edits are applied in order to the evolving text (the 2nd edit can target the 1st edit\'s output)');

  // all-or-nothing
  const atomic = fileCtx(RENAME);
  const bad = await writeFileTool({ path: 'inv.py', edits: [
    { search: 'from .pricing import calc_tot', replace: 'from .pricing import calculate_total' },
    { search: 'THIS TEXT IS NOT IN THE FILE', replace: 'x' },
    { search: 'other = calc_tot([])', replace: 'other = calculate_total([])' },
  ] }, atomic.ctx);
  ok(!bad.ok && /Edit 2 of 3 could not be applied, so NONE of the 3 edits were applied/.test(bad.content) && /the file is unchanged/.test(bad.content), 'a failing edit names itself and NOTHING is applied');
  ok(atomic.state.text === RENAME, 'and the file really is byte-identical afterwards');
  const amb = await writeFileTool({ path: 'inv.py', edits: [{ search: 'calc_tot', replace: 'x' }] }, fileCtx(RENAME).ctx);
  ok(!amb.ok && /Edit 1 of 1/.test(amb.content) && /matches \d+ places/.test(amb.content), 'an ambiguous search inside edits explains the ambiguity (with the edit number)');

  // validation
  ok(!(await writeFileTool({ path: 'x.py', edits: [{ search: 'a' }] }, fileCtx('a').ctx)).ok, 'an edit without "replace" is rejected clearly');
  ok(!(await writeFileTool({ path: 'x.py', edits: [null] }, fileCtx('a').ctx)).ok, 'a null edit is rejected, not a crash');
  ok(!(await writeFileTool({ path: 'x.py', edits: Array.from({ length: 51 }, () => ({ search: 'a', replace: 'a' })) }, fileCtx('a').ctx)).ok, 'more than 50 edits in a call is refused');
  ok(/does not exist/.test((await writeFileTool({ path: 'no.py', edits: [{ search: 'a', replace: 'b' }] }, { ...fileCtx('').ctx, readEffective: async () => undefined } as any)).content), 'edits on a missing file: a clear message');
  const empty = await writeFileTool({ path: 'x.py', edits: [], content: 'fresh\n' }, fileCtx('old\n').ctx);
  ok(empty.ok, 'an empty edits array falls through to the other forms (content) instead of failing');

  // duplicate-definition advisory still fires on the combined result
  const dup = fileCtx('def f():\n    return 1\n');
  const rd = await writeFileTool({ path: 'd.py', edits: [{ search: '    return 1', replace: 'def f():\n    return 2' }] }, dup.ctx);
  ok(rd.ok && /defined 2 times|INSIDE ITSELF/.test(rd.content), 'structural advisories still run over the combined result');

  // per-edit notes: fuzzy match is attributed to its edit
  const fz = fileCtx('def f():\n    a = 1\n    b = 2\n');
  const rf = await writeFileTool({ path: 'z.py', edits: [{ search: 'a  =  1', replace: 'a = 10' }, { search: '    b = 2', replace: '    b = 20' }] }, fz.ctx);
  ok(rf.ok || /Edit 1 of 2/.test(rf.content), 'a whitespace-different search is handled (fuzzy) or reported against its edit number, never silently misapplied');
}

async function testReplaceAll() {
  const { state, ctx } = fileCtx(RENAME);
  const r = await writeFileTool({ path: 'inv.py', search: 'calc_tot', replace: 'calculate_total', all: true }, ctx);
  ok(r.ok && !state.text.includes('calc_tot') && (state.text.match(/calculate_total/g) || []).length === 3, 'all:true replaces every occurrence in one call');
  ok(/Replaced 3 occurrences/.test(r.content), 'and reports how many');
  const one = fileCtx('x = 1\n');
  ok(/Replaced 1 occurrence of/.test((await writeFileTool({ path: 'a.py', search: 'x = 1', replace: 'x = 2', all: true }, one.ctx)).content), 'singular wording for one occurrence');
  const none = await writeFileTool({ path: 'inv.py', search: 'nope', replace: 'x', all: true }, fileCtx(RENAME).ctx);
  ok(!none.ok && /not found in inv\.py/.test(none.content), 'all:true with no match fails clearly');
  ok(!(await writeFileTool({ path: 'inv.py', search: '', replace: 'x', all: true }, fileCtx(RENAME).ctx)).ok, 'an empty search with all:true is refused (it would match everywhere)');
  const amb = await writeFileTool({ path: 'inv.py', search: 'calc_tot', replace: 'x' }, fileCtx(RENAME).ctx);
  ok(!amb.ok && /matches 4 places|matches \d+ places/.test(amb.content), 'WITHOUT all:true an ambiguous search is still refused, as before');
  const lit = fileCtx('a.b a.b\n');
  await writeFileTool({ path: 'l.py', search: 'a.b', replace: '$&', all: true }, lit.ctx);
  ok(lit.state.text === '$& $&\n', 'replacement text is literal (no regex/`$` interpretation)');
  const idem = fileCtx('abab\n');
  await writeFileTool({ path: 'i.py', search: 'ab', replace: 'abab', all: true }, idem.ctx);
  ok(idem.state.text === 'abababab\n', 'a replacement containing the search text is not re-scanned (single pass)');
}

async function testIndentationOnlyEditWhenSearchMatchesAsSubstring() {
  const file = 'def f():\n        x = 1\n    y = 2\n';
  const { state, ctx } = fileCtx(file);
  const r = await writeFileTool(
    { path: 'x.py', search: 'x = 1\n    y = 2', replace: 'x = 1\n        y = 2' },
    ctx,
  );
  ok(r.ok && !/No changes/.test(r.content), 'indentation-only replace applies instead of falsely reporting no change');
  ok(state.text === 'def f():\n        x = 1\n        y = 2\n', 'body line gets the replace indentation verbatim after the anchored header');
  const { execFileSync } = await import('child_process');
  let compiles = false;
  try {
    execFileSync('python3', ['-c', `import ast; ast.parse(${JSON.stringify(state.text)})`], { stdio: 'pipe' });
    compiles = true;
  } catch {
    compiles = false;
  }
  ok(compiles, 'resulting file parses as valid Python');
}

async function testAmbiguousSearchNamesLineNumbers() {
  const body = 'alpha\nbeta\nalpha\nbeta\n';
  const { ctx } = fileCtx(body);
  const r = await writeFileTool({ path: 'inventory/cli.py', search: 'alpha', replace: 'x' }, ctx);
  ok(!r.ok && /matches 2 places in inventory\/cli\.py: lines 1 and 3/.test(r.content), 'ambiguous exact match names the file and line numbers');
  ok(/line 1: alpha/.test(r.content) && /line 2: beta/.test(r.content) && /line 3: alpha/.test(r.content), 'shows each match line and the line before the second match');
}

async function main() {
  await testDoesNotDoubleIndentWhenSearchOmitsLeadingWhitespace();
  await testDoubleIndentAcrossIndentStyles();
  testDedentedDefinitionIsNotForcedIn();
  testOrdinaryReindentStillWorks();
  testDuplicateDefinitionAdvisory();
  testEcho();
  await testWriteResultCarriesEchoAndWarnings();
  await testReplayOfTheFailingRun();
  await testIndentationOnlyEditWhenSearchMatchesAsSubstring();
  await testAmbiguousSearchNamesLineNumbers();
  await testMultiEdit();
  await testReplaceAll();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 edit tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 edit tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_edits.ts:', err); process.exit(1); });
