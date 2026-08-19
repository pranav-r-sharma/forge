/**
 * Item "Outcome mode introduces cheap tricks bypass contrasts": a heuristic,
 * best-effort scan for signs that a "definition of done" check (see
 * verifyCheck.ts / AgentTurnOptions.verifyCommand) started passing not
 * because the underlying goal was actually met, but because the edits made
 * in response to a failure gamed the check itself — disabling/skipping the
 * very tests that were failing, neutering an assertion, silencing an error
 * instead of fixing it, or editing the check command's own script.
 *
 * This mechanism isn't specific to Outcome mode — any mode with a verify
 * command configured (Agent/Auto/Outcome, see modes.ts's
 * modeSupportsVerifyCommand) runs it — but Outcome mode is where it matters
 * most: it's the mode that iterates fully autonomously against a check with
 * no human reviewing each step, so a model under pressure to "finish" has
 * both the least supervision and the most turns in which to find a cheap
 * way to make a red check turn green.
 *
 * IMPORTANT — this is explicitly NOT a guarantee. A determined or confused
 * model can still bypass a check in a way no regex here catches, and a
 * legitimate fix can occasionally trip a pattern (deleting a genuinely
 * obsolete test, or an empty catch block that was already there and
 * untouched by this turn — see the "only scans files actually written this
 * window" note below). It exists to surface a second opinion to the user —
 * "this passed, but here's what changed right before it did, and it looks
 * suspicious" — not to silently block or auto-revert anything. Forge
 * already treats the verify command's own exit code as ground truth
 * (that's the entire point of having one instead of trusting the model's
 * self-report); stacking a second, fuzzier gate on top that could itself
 * block a real "done" would trade one kind of false confidence for
 * another. A visible warning the user can act on is the honest middle
 * ground.
 */
export interface GamingFinding {
  path: string;
  reason: string;
}

const SUSPICIOUS_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\.\s*skip\s*\(/i, reason: 'marks a test as skipped (`.skip(...)`)' },
  { re: /\bx(it|describe|test)\s*\(/, reason: 'uses an "x"-prefixed disabled test (`xit`/`xdescribe`/`xtest`)' },
  { re: /\.\s*only\s*\(/, reason: 'restricts the suite to `.only(...)`, which can hide other failing tests instead of fixing them' },
  { re: /@(pytest\.mark\.skip|unittest\.skip(If|Unless)?|Disabled|Ignore)\b/, reason: 'adds a skip/disable annotation to a test' },
  { re: /except\s*:\s*pass\b/, reason: 'adds a bare `except: pass` that silently swallows an error instead of handling it' },
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/m, reason: 'adds an empty `catch { }` block that silently swallows an error instead of handling it' },
  { re: /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/, reason: 'replaces a real assertion with a tautology (`expect(true).toBe(true)`)' },
  { re: /assert\s+True\s*(#.*)?$/m, reason: 'replaces a real assertion with a tautology (`assert True`)' },
  { re: /\/\/\s*(expect|assert)\s*\(/i, reason: 'comments out an assertion instead of fixing what it checks' },
  { re: /#\s*(self\.)?assert\w*\s*\(/i, reason: 'comments out an assertion instead of fixing what it checks' },
];

/**
 * Scans the text of files written between a failed verify attempt and the
 * next (now-passing) one for the patterns above. `writes` should already be
 * scoped to just that window by the caller (agentLoop.ts) — scanning a
 * file's whole history would flag pre-existing code this turn never
 * touched, which isn't evidence of anything.
 *
 * `verifyCommand` is used only to flag the extra-suspicious case of the
 * check's own script/config being among the edited files — editing the
 * referee, not the code being refereed, regardless of what the edit says.
 */
export function detectSuspiciousVerifyBypass(writes: { path: string; text: string }[], verifyCommand: string): GamingFinding[] {
  const findings: GamingFinding[] = [];
  for (const w of writes) {
    if (!w.text) continue;
    for (const { re, reason } of SUSPICIOUS_PATTERNS) {
      if (re.test(w.text)) {
        findings.push({ path: w.path, reason });
        break; // one flag per file is enough signal — avoid piling up near-duplicate lines for the same edit
      }
    }
  }

  const cmdTokens = verifyCommand.split(/\s+/).filter(Boolean);
  for (const w of writes) {
    if (!w.path || findings.some((f) => f.path === w.path)) continue;
    const base = w.path.split('/').pop();
    if (base && cmdTokens.some((t) => t === w.path || t === base || t.endsWith('/' + base))) {
      findings.push({ path: w.path, reason: "edits the definition-of-done command's own script/file directly" });
    }
  }

  return findings;
}
