// Runtime tests for the 0.12.0 reindentation fix in src/tools/fileTools.ts.
//
// Background: 0.10.0 shipped detectIndentMismatch() as an ADVISORY-ONLY
// check on write_file's search/replace edits — it flagged a likely
// tabs/spaces mismatch between the file and the "replace" text but never
// touched the bytes that actually landed on disk. The user explicitly
// reported this as still broken ("write tool has issues with indentation
// handling"). 0.12.0 adds reindentReplacement(): it detects the file's
// actual indent scheme (tab, or N spaces — estimateSpaceIndentWidth()) and
// the indentation depth at the exact matched location, then remaps every
// line of "replace" onto that scheme while PRESERVING the replace block's
// own relative nesting, before the edit is written. detectIndentMismatch()
// is kept, narrowed to firing only in the residual case where
// reindentReplacement() declines to guess (see fileTools.ts's updated doc
// comments on both functions for the full rationale).
//
// Mirrors every previous test_v*.ts file's ok()/main() harness.
import * as vscode from 'vscode';
import {
  writeFileTool,
  reindentReplacement,
  estimateSpaceIndentWidth,
  dominantIndentChar,
} from '../../src/tools/fileTools';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

function fakeCtx(existing: string | undefined, sink?: { written?: any }) {
  return {
    workspaceRoot: vscode.Uri.file('/ws'),
    readEffective: async () => existing,
    proposeEdit: async (edit: any) => {
      if (sink) sink.written = edit;
      return { id: 'e1', applied: true };
    },
  } as any;
}

// ---------- estimateSpaceIndentWidth: the GCD-based width sniff that extends dominantIndentChar ----------

function testEstimateSpaceIndentWidth() {
  ok(estimateSpaceIndentWidth('    a\n        b\n    c') === 4, 'a file indented at 4 and 8 spaces (multiples of 4) estimates a width of 4');
  ok(estimateSpaceIndentWidth('  a\n  b\n    c') === 2, 'a file indented at 2 and 4 spaces (multiples of 2, not 4) estimates a width of 2, not the coarser guess');
  ok(estimateSpaceIndentWidth('a\nb') === undefined, 'text with no indented lines at all yields no width estimate, not a guessed default');
  ok(estimateSpaceIndentWidth('\ta\n\tb') === undefined, 'a purely tab-indented text has no clean space samples to vote on, so no width is estimated');
}

// ---------- (a) tab-indented file, space-indented replace, exact-match path, multi-level nesting ----------

function testExactMatchTabFileSpaceReplaceMultiLevel() {
  const existing = 'class C {\n\tmethod() {\n\t\treturn 1;\n\t}\n}\n';
  const replace = '        if (cond) {\n            return 2;\n        }'; // 8sp / 12sp / 8sp -> unit 4sp, levels 0,1,0
  const result = reindentReplacement(existing, 2, true, replace);
  ok(result.reindented === true, 'a single-line-consistent space-indented replace against a tab file is confidently reindented');
  ok(
    result.text === '\t\tif (cond) {\n\t\t\treturn 2;\n\t\t}',
    `the replace block is remapped onto the file's tabs, anchored at the matched line's 2-tab depth, with the inner "return" line staying one level deeper than its sibling braces (got ${JSON.stringify(result.text)})`
  );
}

async function testWriteFileToolExactMatchAppliesReindent() {
  const existing = 'class C {\n\tmethod() {\n\t\treturn 1;\n\t}\n}\n';
  const sink: { written?: any } = {};
  const result = await writeFileTool(
    { path: 'foo.ts', search: '\t\treturn 1;', replace: '        if (cond) {\n            return 2;\n        }' },
    fakeCtx(existing, sink)
  );
  ok(result.ok === true, 'the edit succeeds');
  ok(
    sink.written?.newText === 'class C {\n\tmethod() {\n\t\tif (cond) {\n\t\t\treturn 2;\n\t\t}\n\t}\n}\n',
    `writeFileTool actually writes the reindented (all-tabs) text to disk, not the space-indented text as typed (got ${JSON.stringify(sink.written?.newText)})`
  );
  ok(/Note:.*automatically remapped/.test(result.content), 'the tool result notes that indentation was automatically fixed');
}

// ---------- (b) 4-space file, 2-space replace, multiple nesting levels, exact-match path ----------

function testExactMatchFourSpaceFileTwoSpaceReplacePreservesRelativeDepth() {
  const existing = 'function f() {\n    if (a) {\n        old();\n    }\n}\n';
  const replace = '  if (a) {\n    doNew();\n    if (b) {\n      doMore();\n    }\n  }'; // 2sp unit, levels 0,1,1,2,1,0
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === true, '2-space replace against a 4-space file is confidently reindented');
  ok(
    result.text === '    if (a) {\n        doNew();\n        if (b) {\n            doMore();\n        }\n    }',
    `every line lands on a 4-space unit, and the doubly-nested "doMore();" line stays exactly two levels deeper than the outer "if (a)" — relative nesting survives the width change (got ${JSON.stringify(result.text)})`
  );
}

// ---------- (c) same multi-level scenario via the fuzzy-match path ----------

async function testFuzzyMatchPathPreservesRelativeDepth() {
  const existing = 'function f() {\n    if (a) {\n        old();\n    }\n}\n';
  // Deliberately wrong indentation in "search" so the byte-exact match fails
  // and this falls through to findFuzzyLineMatches — whitespace-normalized
  // line matching still finds it uniquely.
  const search = '  if (a) {\n      old();\n  }';
  const replace = '  if (a) {\n    doNew();\n    if (b) {\n      doMore();\n    }\n  }';
  const sink: { written?: any } = {};
  const result = await writeFileTool({ path: 'foo.ts', search, replace }, fakeCtx(existing, sink));
  ok(result.ok === true, 'the fuzzy fallback still applies the edit');
  ok(/whitespace\/indentation/i.test(result.content), 'the fuzzy-match advisory is still surfaced (unaffected by reindentation being added)');
  ok(
    sink.written?.newText === 'function f() {\n    if (a) {\n        doNew();\n        if (b) {\n            doMore();\n        }\n    }\n}\n',
    `reindentation is applied through the fuzzy-match path exactly as through the exact-match path, preserving the same relative nesting (got ${JSON.stringify(sink.written?.newText)})`
  );
}

// ---------- (d) a replace block with no confident common indent width at all still falls back safely ----------
//
// 0.14.0 note: this scenario used to be a single tab-led line mixed among
// space-led lines ('    if (b) {\n\treturn 2;\n    }'), which the OLD
// exact-GCD width estimator treated as irrecoverably inconsistent and
// declined WHOLESALE. Under 0.14.0's per-line, majority-vote-robust
// reindentReplacement() (see estimateSpaceIndentWidthRobust()'s doc
// comment), that exact scenario is now actually resolved correctly instead
// of declined — the file's own tab unit ends up applied to all three lines,
// including the formerly-"inconsistent" one, since a single stray line no
// longer corrupts the whole block's width estimate. See
// test_v14_indent_hardening.ts's testFormerlyMixedCaseNowPartiallyRecovers()
// for that exact case's new, improved behavior. This test now demonstrates a
// scenario that GENUINELY still declines end to end: the non-anchor lines'
// indentation (5, 7, 11 spaces) shares no plausible common step at all (so
// no width is ever confidently estimated), AND the anchor line already
// happens to match the file's own indentation (so the one correction
// reindentReplacement() always applies regardless of width — see its doc
// comment on why the anchor line is exempt from the confidence check — is
// itself a no-op here). See test_v14_indent_hardening.ts for a case where
// the anchor line DOES need correcting even though the rest of the block is
// unresolvable — that one comes back `reindented: true` with the other
// lines listed in `partialLines`, not `false`.

function testMixedIndentationInReplaceFallsBackWithoutCorrupting() {
  const existing = 'function g() {\n\treturn 1;\n}\n';
  const replace = '\ta\n     b\n       c\n           d';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === false, 'a replace block with no plausible common indent width at all, whose anchor line already matches the file, is NOT guessed at — reindenting is declined');
  ok(result.text === replace, 'the declined replace text is returned byte-for-byte unchanged, not partially/incorrectly rewritten');
}

async function testWriteFileToolFallsBackAndStillSurfacesAdvisory() {
  const existing = 'function g() {\n\treturn 1;\n}\n';
  const replace = '\ta\n     b\n       c\n           d';
  const sink: { written?: any } = {};
  const result = await writeFileTool({ path: 'foo.ts', search: '\treturn 1;', replace }, fakeCtx(existing, sink));
  ok(result.ok === true, 'the edit still succeeds — even the fallback case is advisory, never blocking');
  ok(
    sink.written?.newText === `function g() {\n${replace}\n}\n`,
    `the file is written with "replace" exactly as given (not corrupted by a wrong guess) when no confident width exists at all (got ${JSON.stringify(sink.written?.newText)})`
  );
  ok(/Heads up/.test(result.content), 'the old advisory warning fires for this residual case, since reindentReplacement() declined to fix it and the file/replace dominant styles do disagree (tab file vs. space-dominant replace)');
  ok(!/automatically remapped/.test(result.content), 'the "automatically remapped" note does NOT appear, since nothing was actually reindented here');
}

// ---------- (e) blank lines, a column-0 line, and a negative relative depth are all handled correctly ----------

function testBlankLinesAndColumnZeroLineAndNegativeRelativeDepth() {
  const existing = 'function f() {\n\tif (a) {\n\t\tif (b) {\n\t\t\treturn 1;\n\t\t}\n\t}\n}\n';
  // Space-indented replace (4sp unit) with: a blank line, a properly-nested
  // closing brace one level shallower than the anchor, and a closing brace
  // pushed all the way to column 0 — two levels shallower than the anchor's
  // OWN indentation, not just relative to some interior line. That's a
  // negative relative depth past the anchor and must clamp at 0, not throw
  // on a negative repeat() count or emit a bogus negative indent.
  const replace = '            return 2;\n\n        }\n}';
  const result = reindentReplacement(existing, 3, true, replace);
  ok(result.reindented === true, 'reindented despite the blank line and the column-0 line');
  const lines = result.text.split('\n');
  ok(lines[0] === '\t\t\treturn 2;', `the anchor line lands at the matched location's exact original depth (3 tabs) (got ${JSON.stringify(lines[0])})`);
  ok(lines[1] === '', 'the blank line stays blank — no indentation is invented for it');
  ok(lines[2] === '\t\t}', `the one-level-shallower closing brace lands one tab shallower than the anchor (got ${JSON.stringify(lines[2])})`);
  ok(lines[3] === '}', `the column-0 closing brace — deeper negative relative depth than the file even has levels for — clamps to column 0 rather than going negative or crashing (got ${JSON.stringify(lines[3])})`);
}

// ---------- (f) no-op: replace text already in the file's scheme is left unchanged ----------

function testNoOpWhenReplaceAlreadyMatchesFileScheme() {
  const existing = 'function f() {\n\tif (a) {\n\t\treturn 1;\n\t}\n}\n';
  const replace = '\tif (a) {\n\t\treturn 2;\n\t}';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.text === replace, `a replace block already using the file's exact indent scheme and relative nesting comes back byte-for-byte identical (got ${JSON.stringify(result.text)})`);
}

async function testWriteFileToolNoOpEmitsNoAdvisories() {
  const existing = 'function f() {\n\tif (a) {\n\t\treturn 1;\n\t}\n}\n';
  const replace = '\tif (a) {\n\t\treturn 2;\n\t}';
  const result = await writeFileTool({ path: 'foo.ts', search: '\tif (a) {\n\t\treturn 1;\n\t}', replace }, fakeCtx(existing));
  ok(!/Heads up/.test(result.content), 'no residual-fallback advisory when nothing needed fixing');
  ok(!/automatically remapped/.test(result.content), 'no auto-fix note when the replace text was already correct — nothing actually changed');
}

// ---------- template-literal spans are passed through untouched, not reindented into corrupted string content ----------

function testTemplateLiteralInteriorIsNeverReindented() {
  const existing = 'function f() {\n    old();\n}\n';
  const replace = '    const msg = `line1\nline2\n  weird-indent`;\n    doNext();';
  const result = reindentReplacement(existing, 1, true, replace);
  const lines = result.text.split('\n');
  ok(lines[1] === 'line2', `a line whose content lives entirely inside an open template literal is passed through byte-for-byte, not reindented as if it were code (got ${JSON.stringify(lines[1])})`);
  ok(
    lines[2] === '  weird-indent`;',
    `same for the line that closes the template literal — its arbitrary internal "  weird-indent" spacing is part of the string's actual value and must survive untouched (got ${JSON.stringify(lines[2])})`
  );
  ok(lines[3] === '    doNext();', `ordinary code after the template literal closes is still correctly reindented to the file's 4-space scheme (got ${JSON.stringify(lines[3])})`);
}

// ---------- confidently-reindentable requires a real anchor: a mid-line match has none ----------

function testMidLineMatchIsNeverReindented() {
  const existing = 'const x = computeValue(a, b);\n';
  // "search" matches a fragment following real code on the same line —
  // matchStartsAtLineStart is false, so there's no meaningful "this line's
  // indentation" to re-anchor onto.
  const replace = '  computeValue(a, c)';
  const result = reindentReplacement(existing, 0, false, replace);
  ok(result.reindented === false, 'a mid-line match is never reindented, regardless of how the replace text looks');
  ok(result.text === replace, 'the replace text is returned completely unchanged for a mid-line match');
}

// ---------- confidently-reindentable also requires a file with an actual indent scheme to sniff ----------

function testFileWithNoIndentationSignalIsNeverReindented() {
  const existing = 'a\nb\nc\n';
  const replace = '  b2';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === false, 'a flat file with no indented lines at all has no scheme to re-anchor onto, so reindenting is skipped');
  ok(result.text === replace, 'the replace text passes through unchanged');
}

// ---------- dominantIndentChar itself is untouched by this round's changes ----------

function testDominantIndentCharUnaffected() {
  ok(dominantIndentChar('\ta\n\tb') === 'tab', 'dominantIndentChar still reports tab-dominant text as "tab" (unchanged by the reindentation work)');
  ok(dominantIndentChar('  a\n  b') === 'space', 'and space-dominant text as "space"');
}

async function main() {
  testEstimateSpaceIndentWidth();

  testExactMatchTabFileSpaceReplaceMultiLevel();
  await testWriteFileToolExactMatchAppliesReindent();

  testExactMatchFourSpaceFileTwoSpaceReplacePreservesRelativeDepth();

  await testFuzzyMatchPathPreservesRelativeDepth();

  testMixedIndentationInReplaceFallsBackWithoutCorrupting();
  await testWriteFileToolFallsBackAndStillSurfacesAdvisory();

  testBlankLinesAndColumnZeroLineAndNegativeRelativeDepth();

  testNoOpWhenReplaceAlreadyMatchesFileScheme();
  await testWriteFileToolNoOpEmitsNoAdvisories();

  testTemplateLiteralInteriorIsNeverReindented();

  testMidLineMatchIsNeverReindented();
  testFileWithNoIndentationSignalIsNeverReindented();

  testDominantIndentCharUnaffected();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.12.0 indentation runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
