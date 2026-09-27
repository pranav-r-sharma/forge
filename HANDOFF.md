# Hand-off — Forge v0.15.0 (acceptance-test fix-fail-fast loop, run autonomously)

**Written:** 2026-09-27, by the previous agent, at the owner's request to hand this to a fresh agent.
**For:** the next agent picking this up.
**Read this whole file before touching anything.** Then `CLAUDE.md` (standing rules — binding, read this one **first**, actually) and `PROGRESS.md` (live state — trust it over this document for "what's next" if they disagree).

**Key difference from the last hand-off: the owner does not want to be involved this time.** Previously, the instruction was "report findings, do not implement fixes, let the owner decide." That has changed: **you are pre-authorized to find harness bugs, fix them, and re-run, in a loop, without stopping to ask** — within the bounds this document and CLAUDE.md set out. Read the "Autonomy: what you may do without asking" section below carefully; it is a real boundary, not a formality.

---

## 0. Do this before anything else

1. Read `CLAUDE.md` in full. Standing rules and the dev cycle. Not optional. Nothing in this document overrides it — this hand-off narrows an existing standing-rule 8 task, it doesn't create new exceptions to rules 1–9.
2. Read `PROGRESS.md` in full, especially the last ~10 "Done" entries (they cover this exact acceptance-test effort in detail: what was found, what was fixed, why).
3. `git log --oneline | head -10`, `git status --short`, `git branch --show-current` — confirm you're on `v0.15.0-work`, the tree is clean, and the last commit is `3e7cf13` ("Confirm fix #1 live, record fix #2 not exercised, and a third (unfixed) finding"). If it doesn't match, trust the repo over this document.
4. `npm run typecheck && npm test && npm run compile` — must be clean (37/37 files, 1,359 checks) before you change anything.
5. `pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"` — confirm nothing is orphaned and memory is healthy before loading anything.
6. If you find repo state that doesn't look like your own — files you didn't create, uncommitted changes you don't recognize — **stop and ask the owner before touching or committing over it.** This happened once already this session (an unrelated agent was downloading a different model into this same repo, concurrently); it was resolved by the owner moving that work elsewhere, but if you see anything similar, don't assume it's safe to overwrite.

---

## 1. Where things stand (short version — PROGRESS.md has the full detail)

Phase 0 of the v0.15.0 plan is complete. MLX-4bit is the live default provider. A 7th eval task, `_devtools/e2e/tasks/t07-build-from-scratch`, was built specifically for CLAUDE.md's standing rule 8 (the harness must write a multi-file program from an **empty** repo, not just fix/extend an existing one — none of `t01`–`t06` do this).

**This session so far has run that acceptance test 4 times and found three distinct things:**

1. **Bug #1 (fixed, commits `780b3b3` + `c776f01`):** a large `write_file` whose generation ended on the model's own stop token *mid-JSON-string* (not a token-budget cutoff — `finishReason: "stop"`) produced an unparseable `forge_action` block, which the harness then silently accepted as a "final answer" instead of retrying — the task just quietly ended with almost nothing written, no error shown. Fixed in `src/agent/toolProtocol.ts` (`looksLikeAbandonedToolCall`) + `src/agent/agentLoop.ts` (generalizes the existing length-cutoff retry to also cover this case). **Confirmed fixed with live evidence**, not just unit tests: the exact bug recurred on a real rerun and the new retry logic caught it (see PROGRESS.md's "Confirmation rerun" entry).
2. **Bug #2 (fixed, commit `435044e`):** stuck on a self-misdiagnosed test failure, the model ran `rm -rf` on its own absolute workspace path to "start over." It succeeded — real, unrecoverable, workspace-gone. Forge already has a dangerous-command denylist that gates destructive actions behind approval even in Auto mode, but its `rm -rf` pattern only covered `/` and `~`, not the agent's own workspace root. Fixed in `src/tools/commandTool.ts` (`isWorkspaceWipe`) + plumbing through `types.ts`/`approvalBroker.ts`/`agentLoop.ts`, plus a necessary second fix in `_devtools/bench/run_task.ts` (the headless runner had no way to ever resolve an approval prompt, so a real hit would have hung forever past `--timeout-s` — now auto-denies immediately in headless mode). **Not yet exercised live** — the model didn't attempt `rm -rf` on the confirmation rerun, so this one is proven only by its 14 unit tests so far. If your loop ever reproduces the same self-destructive pattern, that's your chance to confirm it live — watch for it.
3. **A third finding, NOT fixed, and correctly so:** on the confirmation rerun, the model wrote `tests/test_storage.py` before `contacts/storage.py` existed, misdiagnosed the resulting import error as a broken Python editable-install/meta-path-finder problem, and spent its entire 600s budget building an elaborate (wrong) workaround instead of ever just writing the missing file. Forge behaved correctly throughout — every tool call did exactly what it was asked and reported the truth. This is a **model reasoning-depth limitation**, not a harness defect. It was recorded, not fixed. This is your calibration example for "model limitation, leave it alone" — see the classification guidance below.

Read PROGRESS.md's entries from "## Fix #1 applied..." through "## Confirmation rerun..." for the full evidence trail before starting — it'll save you from re-deriving conclusions already reached.

---

## 2. Your task: continue the fix-fail-fast loop, autonomously

Standing rule 8 (CLAUDE.md) asks for the harness to be run and *improved* until it works well on a from-scratch build. You are continuing that work. The loop, each cycle:

1. **Run** `t07-build-from-scratch` on MLX-4bit/Ornith-1.5-9B (the only approved model/runtime combo per Directive 1 — no exceptions), watched live, not just launched and checked at the end.
2. **Watch live, and fail fast.** The moment you recognize a genuine **harness bug** happening (not a model reasoning slip — see classification below), **kill the run immediately** (`TaskStop` on the background task; confirm no orphaned `mlx_lm.server` afterward). Do not let a run you already know is broken burn through its remaining iterations or timeout — that was wasted time last cycle and the owner flagged it as the right call ("kill the test, fix the bug, rerun").
3. **Root-cause precisely.** Read the trace (`trace_report.py`) and the full message transcript (`.messages.json`) — a summary metric alone will not show you *why*, the way it didn't for any of the three findings above.
4. **Fix it**, following CLAUDE.md's dev cycle exactly: the smallest correct change, new/updated unit tests proving the fix (reproduce the bug shape in a scripted test, not just the live symptom), full suite green (`npm run typecheck && npm test && npm run compile`), one commit for the fix.
5. **Restart the acceptance test from a fresh empty workspace** (this already happens automatically — `run_task.ts` `mkdtemp`s a new workspace and copies the empty `repo/` into it on every invocation, so you never need to manually reset anything).
6. **Log the cycle** in `_devtools/e2e/ITERATION_LOG.md` (new file — create it if it doesn't exist; format below) *and* in `PROGRESS.md` (the detailed technical record, same style as the existing entries), then commit both.
7. Repeat.

### Classifying a failure: harness bug vs. model limitation

This is the judgment call the whole loop depends on. Get it wrong in the "fix a model limitation" direction and you'll waste time chasing something no code change can solve; get it wrong in the "call a real bug a model quirk" direction and you'll miss real fixes. Use the three findings above as your calibration:

**Harness bug** (fix it) — Forge's own code does something wrong, regardless of what the model asked for:
- A valid or near-valid model action is silently dropped, misinterpreted, or accepted as something it isn't (bug #1's shape).
- Forge lets something irreversible/unrecoverable happen that it has the means to prevent, especially something already covered in spirit by an existing safety mechanism that's just incomplete (bug #2's shape).
- A crash, exception, or unhandled error inside Forge's own tool/agent-loop code.
- A tool result that's misleading, wrong, or inconsistent with the real on-disk/process state.
- An infinite hang with no way out (no timeout, no recovery path).

**Model limitation** (record it, do not fix) — Forge behaved correctly; the *model's own reasoning* was the problem:
- A wrong diagnosis, a logic bug in code the model wrote, a misreading of its own test output, going down an unproductive rabbit hole — as long as every tool Forge ran reported the truth and did what it was asked (finding #3's shape).
- This was already the explicit precedent before this session too: the `del`-keyword t06 finding (PROGRESS.md, "§7.3 RESOLVED") was deliberately left unfixed by owner decision, specifically because it was model behavior, not a Forge defect.
- If you're tempted to "fix" a model limitation by adding a prompt hint, a special-cased nudge, or new guardrail scoped to one specific mistake — stop. That's model-behavior-shaping, not a harness bug fix, and it's out of scope for this loop even under the autonomy grant below.

**Genuinely unsure which it is:** don't guess and don't fix. Log it in the iteration log as "unclear — needs owner input," describe both readings, and treat it as a model limitation for now (don't touch code) so the loop can keep moving. Flag it prominently when you eventually report back.

### Autonomy: what you may do without asking

You are authorized, for this loop only, to implement a fix and re-run **without pausing for approval**, provided the fix:
- Is a small, targeted change that addresses the specific bug you just root-caused — not a refactor, not a redesign, not speculative hardening for a case you haven't actually observed.
- Doesn't require anything CLAUDE.md's standing rules already gate behind asking first: no `sudo`, no new installs/downloads (brew, another Python, another model, another runtime) — Ornith-1.5-9B / MLX-4bit only, no exceptions, per Directive 1.
- Stays on branch `v0.15.0-work`. Never push. Never touch `master`/`main`.
- Is fully covered by new or updated unit tests, with the full suite (`npm test`, `npm run typecheck`, `npm run compile`) green before you commit.
- Is committed as its own step (one fix = one commit) before you restart the test — never batch multiple unrelated fixes into one commit, and never leave the repo in a broken state between cycles.

**Stop and ask instead** (post a clear summary and pause, don't guess) if:
- A fix would need something outside the bounds above (a new dependency, a different model/runtime, a genuinely large or risky change, touching product behavior far outside the agent loop/tool layer).
- You cannot confidently classify a failure after real investigation (see above — default to "don't touch code" in this case, not to "fix it and hope").
- You hit unfamiliar repo state you didn't create (see §0.6).
- You're near the context-limit pause threshold (CLAUDE.md rule 7) — follow that protocol exactly: finish the current step, update `PROGRESS.md` and the iteration log, commit, state the pause out loud, and stop for 45 minutes before resuming from `PROGRESS.md`. This applies *across* cycles too — don't treat "the loop isn't done yet" as a reason to skip the pause rule.

### Stopping conditions for the whole loop

You are not looking for infinite iteration. Stop and produce a final report when any of these is true:

1. **Success:** the acceptance test passes end-to-end. Get at least 2 consecutive clean passes before calling it solid (temp-0 has shown near-but-not-fully-deterministic behavior before — see PROGRESS.md's t03/t06 flakiness notes).
2. **Model-limitation floor reached:** a run fails, you've correctly classified it as a model limitation (not fixable in code), and you have no reason to think another run would surface a *different* harness bug. This is an acceptable, legitimate stopping point — the acceptance test's job is to find and fix *harness* bugs, not to make a 9B model perfect. Report the model-limitation finding for the owner to decide what (if anything) to do about it.
3. **Safety valve:** after 5 fix-and-rerun cycles in one sitting, stop regardless of outcome and report progress — even if you believe you're close. This isn't a hard technical limit, it's a check-in point so autonomous work doesn't run away unbounded.
4. **Budget:** the context-limit pause protocol above fires.

When you stop for any reason, make sure `PROGRESS.md`, the iteration log, and `git log` all agree on the current state before you do.

### The iteration log (`_devtools/e2e/ITERATION_LOG.md`)

New file, doesn't exist yet — create it. This is a lightweight, at-a-glance record so the owner can check progress by opening one file, without interrupting you or asking you directly. Append one entry per cycle, in order, oldest first. Format:

```markdown
## Cycle N — YYYY-MM-DD HH:MM

- **Run:** t07-build-from-scratch, MLX-4bit/Ornith-9B, thinking=auto terse=true, max-iters 40, timeout-s 600
- **Result:** PASS | FAIL — killed early at iteration X (harness bug found) | ran to completion at iteration Y/40 or Zs timeout
- **Classification:** harness bug | model limitation | success | unclear (needs owner input)
- **Finding:** one or two sentences — what happened, root cause if known
- **Fix:** commit `<hash>` — one-line summary (omit this line entirely for model-limitation or success entries)
- **Evidence:** `_devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle<N>.*`
- **Next:** rerun | stop — success | stop — model-limitation floor reached | stop — safety valve (5 cycles) | paused — budget
```

Keep entries short — this is an index, not a narrative. The narrative (full root cause, code locations, reasoning) still goes in `PROGRESS.md` as before; the iteration log just makes "what's the current cycle count and status" a one-glance answer. Commit the iteration log update together with each cycle's fix commit (or as its own trivial commit if the cycle was a clean pass/model-limitation with no code change).

**Result-file naming going forward:** use `_devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle<N>.*` (replacing the ad hoc `-r1`/`-r2`/`-postfix-*` naming from this session) so cycles are easy to find in order. Use `--keep` when you need to inspect a failure's workspace; clean up old kept `$TMPDIR/forge-e2e-*` directories occasionally if they accumulate (they're disk-cheap but numerous after several cycles).

---

## 3. Standing rules that apply here — do not violate

From `CLAUDE.md` (read the full file):
1. **Ornith-1.5-9B / MLX-4bit only.** No exceptions, no other models, no other runtimes, even to "quickly check" something.
2. **No `sudo`** in anything that ships or that you run as part of this loop.
3. **One model loaded at a time.** Check `ollama ps` / `pgrep -fl mlx_lm.server` before loading; confirm cleanup after killing a run.
4. **Work on `v0.15.0-work`.** Never commit to `master`/`main`. Never push without being asked.
5. **Dev cycle:** small steps, test/verify after each, update `PROGRESS.md` (and now the iteration log), commit — one step per commit.
6. **Budget discipline:** state your remaining token count before any background/long-running run, at every `Monitor` re-arm, and before starting a new cycle. You cannot see the account's plan usage limit, only your own remaining tokens — state it anyway, every time, out loud in your reply.
7. **A repeated operation stops at its first failure to diagnose it** — this is the fail-fast requirement above, formalized. Don't let a run you know is broken keep going.
8. **Never delete/overwrite work you haven't read.** `_devtools/e2e/results/*` has real committed evidence from this and prior sessions — don't touch existing files, only add new ones.
9. **Report faithfully.** If a cycle's classification is genuinely unclear, say so — don't force it into "bug" or "model limitation" for a tidier log entry.

---

## 4. Quick reference

```bash
# Confirm state
npm run typecheck && npm test && npm run compile
git log --oneline -10 && git status --short && git branch --show-current
pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"

# The MLX-4bit snapshot (Ornith only)
S4=$(ls -d ~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/*)

# One cycle's run, workspace kept for inspection afterward, watched live (tail the log in parallel)
node _devtools/run-ts.js _devtools/bench/run_task.ts \
  --task t07-build-from-scratch --provider mlx --model "$S4" \
  --thinking auto --terse true --out _devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle<N>.json \
  --timeout-s 600 --max-iters 40 --keep > /tmp/t07-cycleN.log 2>&1 &

# Summarize the trace
python3 _devtools/bench/trace_report.py _devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle<N>.trace.jsonl
```

Read the transcript yourself before trusting a summary metric — that's how all three findings so far were actually found.

Good luck.
