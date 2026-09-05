// ============================================================================
// 0.14.0: write_file indentation hardening.
//
// Follows up on 0.12.0's reindentReplacement() (test_v12_indent.ts) with a
// specific, reported failure mode: a multi-line "replace" block where ONE
// line's indentation is a stray outlier (a model drifting by a space or a
// tab partway through a long block) used to corrupt or bail the WHOLE
// block's correction, not just that one line — see
// estimateSpaceIndentWidthRobust()'s doc comment in fileTools.ts for the
// exact mechanism (an exact-GCD width estimate collapsing to 1 the moment
// one line doesn't fit the pattern, which then makes every line look
// "confident" against a corrupted width instead of triggering the old
// all-or-nothing bail).
//
// This file tests three things the user specifically asked about:
//   1. A single-outlier-line block, past the ~10-15 line point drift becomes
//      likely, is now corrected on the good lines with the bad one(s) left
//      exactly as-authored, not silently corrupted or wholesale declined.
//   2. The mechanism is language-agnostic (works identically on
//      indentation-significant Python, not just brace languages) — see
//      testPythonStyleIndentationDrift() below, which answers the "is this
//      worse in Python vs. brace languages" question the request raised:
//      the fix operates purely on leading whitespace, with no
//      brace/keyword awareness either way, so there's no language-specific
//      gap to prioritize.
//   3. The formerly-declined 0.12.0 test scenario (a single tab-led line
//      amid space-led lines) is now actually resolved instead of declined.
//
// Mirrors every previous test_v*.ts file's ok()/main() harness.
import * as vscode from 'vscode';
import { writeFileTool, reindentReplacement, estimateSpaceIndentWidthRobust } from '../../src/tools/fileTools';
import { ToolExecContext } from '../../src/agent/types';

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

function fakeCtx(existing: string | undefined, sink: { written?: any } = {}): ToolExecContext {
  return {
    workspaceRoot: vscode.Uri.file('/ws'),
    cancellation: new vscode.CancellationTokenSource().token,
    proposeEdit: async (edit) => {
      sink.written = edit;
      return { id: 'e1', applied: true };
    },
    readEffective: async () => existing,
  } as any;
}

// ---------- estimateSpaceIndentWidthRobust: majority vote tolerates a single outlier; genuine ambiguity still returns undefined ----------

function testRobustWidthEstimation() {
  const cleanFour = '    a\n        b\n    c'; // 4, 8, 4
  ok(estimateSpaceIndentWidthRobust(cleanFour) === 4, 'a clean, consistent 4-space block estimates width 4 same as the exact estimator would');

  // One outlier (11 instead of 12) among otherwise-clean 4-space multiples —
  // the exact-GCD estimator collapses to 1 here (gcd(4,8,11,12)===1); the
  // robust estimator should still recover 4 by majority vote.
  const oneOutlierOfFour = '    a\n        b\n            c\n           d'; // 4, 8, 12, 11
  ok(estimateSpaceIndentWidthRobust(oneOutlierOfFour) === 4, `a single outlier line among otherwise-consistent 4-space indentation still yields width 4 by majority vote, not undefined or a corrupted width (got ${estimateSpaceIndentWidthRobust(oneOutlierOfFour)})`);

  // Genuinely ambiguous: no shared plausible step at all between 2 and 5.
  const genuinelyAmbiguous = '  a\n     b';
  ok(estimateSpaceIndentWidthRobust(genuinelyAmbiguous) === undefined, `two indented lines sharing no plausible common step (2 and 5 spaces) still yield "can't tell", not a false-confident guess (got ${estimateSpaceIndentWidthRobust(genuinelyAmbiguous)})`);

  ok(estimateSpaceIndentWidthRobust('') === undefined, 'no indented lines at all yields undefined, not a crash');
}

// ---------- reindentReplacement: a single stray line no longer corrupts or bails a long, otherwise-consistent block ----------

function testSingleOutlierLineIsIsolatedNotCorruptingOrBailing() {
  const existing = 'class C {\n\tmethod() {\n\t}\n}\n';
  // 4-space nested structure with one stray line (11 instead of 12 spaces)
  // simulating a model drifting mid-block — the scenario root-cause #3 in
  // the request specifically called out ("past ~10-15 lines").
  const replace =
    'if (a) {\n' +
    '    if (b) {\n' +
    '        if (c) {\n' +
    '            doThing1();\n' +
    '            doThing2();\n' +
    '           doThing3();\n' + // <-- 11 spaces, not 12: the stray line
    '            doThing4();\n' +
    '        }\n' +
    '    }\n' +
    '}';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === true, 'the block IS reindented despite the one stray line — no whole-block bail');
  const lines = result.text.split('\n');
  ok(lines[0] === '\tif (a) {', `the anchor line lands at the file's matched depth (got ${JSON.stringify(lines[0])})`);
  ok(lines[3] === '\t\t\t\tdoThing1();' && lines[4] === '\t\t\t\tdoThing2();' && lines[6] === '\t\t\t\tdoThing4();', `the clean, consistent lines around the outlier are all correctly reindented to the file's tab scheme (got ${JSON.stringify([lines[3], lines[4], lines[6]])})`);
  ok(lines[5] === '           doThing3();', `the one genuinely inconsistent line is left exactly as the model wrote it, not silently corrupted onto a wrong depth (got ${JSON.stringify(lines[5])})`);
  ok(Array.isArray(result.partialLines) && result.partialLines.length === 1 && result.partialLines[0] === 6, `partialLines names exactly the one line (1-indexed within the replace block) that was left unresolved (got ${JSON.stringify(result.partialLines)})`);
}

// ---------- reindentReplacement: even a fully ambiguous block still gets its anchor line corrected if that alone needs fixing ----------

function testAnchorLineStillCorrectedEvenWhenRestIsUnresolvable() {
  const existing = 'function g() {\n\treturn 1;\n}\n';
  // No plausible common width across "  a" (2), "     b" (5), "       c" (7),
  // "           d" (11) — but the anchor line's OWN correction (matching the
  // file's tab depth) doesn't depend on width estimation at all.
  const replace = '  a\n     b\n       c\n           d';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === true, 'the anchor line alone needing correction is enough to report reindented:true, even though nothing else in the block could be resolved');
  const lines = result.text.split('\n');
  ok(lines[0] === '\ta', `the anchor line is corrected to the file's actual indentation regardless of the rest of the block's ambiguity (got ${JSON.stringify(lines[0])})`);
  ok(lines[1] === '     b' && lines[2] === '       c' && lines[3] === '           d', 'every other, unresolvable line is left exactly as authored');
  ok(Array.isArray(result.partialLines) && result.partialLines.length === 3 && result.partialLines.join(',') === '2,3,4', `partialLines names the three unresolved lines, 1-indexed (got ${JSON.stringify(result.partialLines)})`);
}

// ---------- the formerly-declined 0.12.0 scenario now actually resolves instead of bailing ----------

function testFormerlyDeclinedMixedTabSpaceCaseNowResolves() {
  const existing = 'function g() {\n\treturn 1;\n}\n';
  // Exactly test_v12_indent.ts's original (pre-0.14.0) "falls back safely"
  // scenario — one tab-led line amid two 4-space-led lines. The OLD
  // exact-GCD estimator declined this wholesale (see that file's updated
  // comment). The robust estimator correctly reads this as "2 confident
  // 4-space lines, 1 excluded (not a clean space sample at all, it's
  // tab-led)" and reindents everything onto the file's own tab scheme,
  // including the tab-led line, which happens to already be exactly one
  // level deep — a coherent, fully corrected result instead of a decline.
  const replace = '    if (b) {\n\treturn 2;\n    }';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === true, 'this scenario is no longer declined outright — most of it is now confidently reindented');
  ok(result.text === '\tif (b) {\n\treturn 2;\n\t}', `the whole block ends up consistently tab-indented, one level deep, matching the anchor (got ${JSON.stringify(result.text)})`);
  // The middle line ("\treturn 2;") is technically left byte-for-byte
  // unresolved (its tab doesn't decompose against the OTHER two lines'
  // 4-space unit) rather than arithmetically remapped — it just happens to
  // already equal what a correct remap would produce, so the visible RESULT
  // is fully correct even though partialLines still honestly reports it.
  ok(Array.isArray(result.partialLines) && result.partialLines.length === 1 && result.partialLines[0] === 2, `the middle line is reported as unresolved-but-coincidentally-correct rather than silently claimed as confidently remapped (got ${JSON.stringify(result.partialLines)})`);
}

// ---------- language-agnosticism: works identically on indentation-significant Python, not just brace languages ----------

function testPythonStyleIndentationDrift() {
  const existing = 'def outer():\n    if a:\n        pass\n';
  // 4-space Python nesting, no braces at all, same single-outlier-line drift
  // shape as the brace-language test above.
  const replace =
    'if b:\n' +
    '    if c:\n' +
    '        do_thing_1()\n' +
    '       do_thing_2()\n' + // <-- 7 spaces, not 8: the stray line
    '        do_thing_3()';
  const result = reindentReplacement(existing, 1, true, replace);
  ok(result.reindented === true, 'Python-style (brace-free) indentation drift is handled by the exact same mechanism — reindentReplacement() only ever looks at leading whitespace, never language syntax');
  const lines = result.text.split('\n');
  ok(lines[0] === '    if b:', `the anchor line lands at the file's matched 4-space depth (got ${JSON.stringify(lines[0])})`);
  ok(lines[2] === '            do_thing_1()' && lines[4] === '            do_thing_3()', `the clean lines around the outlier are correctly reindented (got ${JSON.stringify([lines[2], lines[4]])})`);
  ok(lines[3] === '       do_thing_2()', 'the one inconsistent line is left exactly as authored rather than guessed at — same graceful degradation as the brace-language case');
}

// ---------- writeFileTool surfaces which specific line(s) were left unresolved, not a blanket "declined" or "all fixed" message ----------

async function testWriteFileToolAdvisoryNamesPartialLines() {
  const existing = 'class C {\n\tmethod() {\n\t}\n}\n';
  const replace = '    if (b) {\n            doThing1();\n           doThing2();\n            doThing3();\n    }';
  const sink: { written?: any } = {};
  const result = await writeFileTool({ path: 'foo.ts', search: '\tmethod() {\n\t}', replace }, fakeCtx(existing, sink));
  ok(result.ok === true, 'the edit still succeeds even with one unresolved line inside an otherwise-fixed block');
  ok(/automatically remapped/.test(result.content) && /EXCEPT line/.test(result.content), `the advisory says most of the block was remapped AND names the exception, not a blanket "declined" message (got ${JSON.stringify(result.content)})`);
  ok(/line\(s\) 3/.test(result.content), `the advisory names the actual 1-indexed line number within "replace" that was left unresolved (got ${JSON.stringify(result.content)})`);
}

async function main() {
  testRobustWidthEstimation();
  testSingleOutlierLineIsIsolatedNotCorruptingOrBailing();
  testAnchorLineStillCorrectedEvenWhenRestIsUnresolvable();
  testFormerlyDeclinedMixedTabSpaceCaseNowResolves();
  testPythonStyleIndentationDrift();
  await testWriteFileToolAdvisoryNamesPartialLines();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.14.0 indentation hardening runtime tests FAILED.');
    process.exit(1);
  } else {
    console.log('All v0.14.0 indentation hardening runtime tests passed.');
  }
}

main().catch((err) => {
  console.error('Uncaught error in test_v14_indent_hardening.ts:', err);
  process.exit(1);
});
