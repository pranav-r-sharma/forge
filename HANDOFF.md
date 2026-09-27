# Hand-off — Forge v0.15.0 (acceptance-test loop, take 3)

**Written:** 2026-09-27, by the previous agent, at the owner's request.
**For:** the next agent picking this up.
**Read this whole file before touching anything.** Then `CLAUDE.md` (standing rules — binding, read first) and `PROGRESS.md` (live state — trust it over this document for "what's next" if they disagree; read at least the last ~6 entries, they cover this exact effort in detail).

---

## 0. Do this before anything else

1. Read `CLAUDE.md` in full. Nothing in this document overrides it.
2. Read `PROGRESS.md`'s last ~6 entries (from "Handed off again (2026-09-27): continue as an autonomous fix-fail-fast loop" through the end).
3. `git log --oneline | head -10`, `git status --short`, `git branch --show-current` — confirm you're on `v0.15.0-work`, the tree is clean, and the last commit matches what `git log` shows at hand-off time (check the commit that adds this file). If it doesn't match, trust the repo over this document.
4. `npm run typecheck && npm test && npm run compile` — must be clean before you change anything.
5. `pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"` — confirm nothing orphaned, memory healthy.
6. Unfamiliar repo state you didn't create → **stop and ask the owner**, don't touch or commit over it.

---

## 1. Where things stand (short version — PROGRESS.md has full detail)

Two real harness bugs were found and fixed earlier in this effort (abandoned-mid-JSON-action silently accepted as a final answer; a workspace-wipe gap in the dangerous-command guard). Both are done, tested, committed — do not revisit unless you find new evidence they're incomplete.

**This session (cycles 1-2 of the autonomous loop) found two more things, and the owner made two decisions as a result:**

1. **`t07-build-from-scratch` is retired.** Its `check.sh` (built in an earlier session) hard-requires `unittest.TestCase`-style tests, but `task.md` never says so — cycle 2's model wrote a fully correct program with valid pytest-style tests, verified by hand to pass `acceptance.py` end-to-end, and still failed the grading script because `unittest discover` doesn't recognize pytest-style test functions. **This is a fixture defect, not a Forge bug and not a model mistake.** Per the "never delete/overwrite work you haven't read" rule, its files and this session's cycle 1/2 results are **not deleted** — they stay as historical record under `_devtools/e2e/tasks/t07-build-from-scratch/` and `_devtools/e2e/results/t07-*`. **Your job includes designing its replacement** (see §4).

2. **A real, buildable harness gap was found by reading the full message transcript, not just the trace summary — fix this first, before anything else.** Read PROGRESS.md's "cycle 2" entry in full for the transcript evidence, but in short:
   - The existing abandoned-action-nudge (`src/agent/agentLoop.ts`, fires when `looksLikeAbandonedToolCall` in `src/agent/toolProtocol.ts` detects a `"tool":"..."` fragment that never finished parsing) sends this message: *"Your last reply started an action but the JSON was left incomplete... reply now with **your next action**..."*
   - That wording never says *which* action was left unfinished. It just says "your next action" — which the model can, and did, read as license to do something else entirely (move on to a different file) instead of resuming the one that got cut off.
   - This is the actual mechanism behind the "wrote the test file before the file it imports" pattern that's been recorded across three separate cycles/sessions as a vague "model reasoning limitation." It isn't purely that — the harness's own recovery message is ambiguous enough to let this happen. One cycle self-corrected anyway (got lucky, found the missing file itself after a long detour); others didn't and burned their entire budget on a wrong theory instead.
   - **The fix:** `looksLikeAbandonedToolCall` (or a sibling helper) should extract the tool name and path from the leftover JSON fragment when possible (a regex over the partial `{"tool":"write_file","args":{"path":"...` text is enough — you don't need it to be a full parse) and the nudge message should name that file explicitly: *"You were in the middle of writing `contacts/storage.py`. Finish writing that exact file now — do not move on to a different file."* Fall back to the current generic wording only when extraction genuinely fails (e.g. the fragment is too short to contain a path yet). Apply the same treatment to the `truncated-reply-nudge` (the `finishReason === 'length'` sibling case, same code block) — it has the identical generic-wording gap.
   - Look at `findUnverifiedClaims`'s nudge (same file, a few lines below) as the existing good pattern to match: it already names specific paths (`You said you changed \`foo.ts\`... call write_file now`) instead of a vague "try again."
   - New unit tests: reproduce an abandoned `write_file` fragment with a known path, confirm the nudge names that path; confirm the fallback still works when no path is extractable; a truncated-reply-length case too.

---

## 2. New standing instruction — be strict about catching AI mistakes the harness can name (owner directive, 2026-09-27)

**This applies to this loop going forward, not just the one fix above.** Whenever Forge's own code can programmatically detect a specific, identifiable defect in what the model just did — an abandoned/incomplete action, an unverified claim, a dangerous command, or any other pattern the code can pin down precisely (not a vague "something seems off," but something the code can actually name) — **the harness must not let the model simply drift to something else.** It must state, explicitly and concretely, exactly what was wrong and what the model needs to do about it — naming the specific file/tool/action involved, never a generic "try again" or "your next action" — and require the model to resolve *that exact thing* before any other action is accepted as valid progress.

Concretely, as you continue the fix-fail-fast loop:
- Every time you find a nudge, retry message, or recovery path in the agent loop that's currently generic where it could be specific (the code already knows more than it's telling the model), tighten it the same way as the fix in §1 — name the exact thing, don't just prompt for "next action."
- This is a real code-quality bar for the harness now, not just a one-off bug fix: a vague recovery message that lets a known, named problem go unaddressed is itself something worth treating as a small harness gap, in the same spirit as bugs #1 and #2 before it — even if the model would probably self-correct anyway. Don't assume "the model usually figures it out" is good enough when the code could just tell it directly.
- Still bounded by the same autonomy rules as everything else in this loop (§3 below) — small, targeted, test-covered changes; nothing speculative or unobserved.

---

## 3. Standing rules that still apply — do not violate

From `CLAUDE.md` (read the full file): Ornith-1.5-9B/MLX-4bit only, no sudo, no new installs without asking, work only on `v0.15.0-work`, one small step per commit, one model loaded at a time, state remaining token budget before any background/long-running run and at every `Monitor` re-arm, a repeated operation stops at its first failure to diagnose it, never delete/overwrite work you haven't read, report faithfully.

**Autonomy grant (unchanged from the last hand-off):** you may implement a fix and re-run without pausing for approval, provided it's a small targeted change addressing a specific root-caused issue (not a refactor/redesign/speculative hardening), doesn't need anything CLAUDE.md gates behind asking first, stays on `v0.15.0-work`, is covered by new/updated unit tests with the full suite green, and is committed as its own step before you restart the test. Stop and ask if a fix needs something outside those bounds, you can't confidently classify a failure, you hit unfamiliar repo state, or you're near the budget-pause threshold.

**Classifying a failure — harness bug vs. model limitation** (calibration examples in PROGRESS.md's "Confirmation rerun" and "cycle 2" entries):
- **Harness bug (fix it):** Forge's own code does something wrong regardless of what the model asked for — a valid/near-valid action silently dropped or misinterpreted; something irreversible allowed through an incomplete safety net; a crash/exception in Forge's own code; a misleading tool result; an unrecoverable hang. **Also now includes:** a recovery/nudge message that's vaguer than the code's own knowledge lets it be (§2).
- **Model limitation (record it, don't fix):** every tool did what it was asked and reported the truth; the model's own reasoning was wrong (bad diagnosis, logic bug in its own code, an unproductive rabbit hole it never escaped). Don't prompt-hint or special-case-guard against one specific model mistake — that's out of scope even under this grant.
- **Genuinely unsure:** don't guess, don't fix. Log as "unclear — needs owner input," treat as model limitation for now (don't touch code), flag prominently.

**Stopping conditions for the loop:** success (≥2 consecutive clean passes), model-limitation floor reached (correctly classified, no reason to expect a different bug from another run), a 5-cycle safety valve per sitting, or the budget-pause protocol.

**Iteration log** (`_devtools/e2e/ITERATION_LOG.md`) — keep using it exactly as before: one short entry per cycle (run config, result, classification, fix commit if any, evidence path, next action). `PROGRESS.md` stays the detailed narrative. Commit both together with each cycle's fix (or as a trivial commit on a clean pass/model-limitation cycle with no code change).

**Fail-fast** — the moment you recognize a genuine harness bug happening live, kill the run immediately (`TaskStop`, confirm no orphaned `mlx_lm.server`), fix, rerun. Don't let a run you already know is broken burn its remaining budget.

---

## 4. Your task, in order

1. **Fix the abandoned-action/truncated-reply nudge specificity gap** (§1.2) first — it's already root-caused, already scoped, already approved. Small change, new tests, full suite green, one commit.
2. **Design a replacement for `t07-build-from-scratch`.** It needs to still be a genuine build-from-scratch task (CLAUDE.md standing rule 8), well-specified enough that a failure points at harness/model behavior rather than spec ambiguity, and — the lesson from this session — its grading script must not silently assume a test framework/style the task instructions never actually require. **Present options to the owner and get explicit approval before building it** (per the option-catalog-and-approval rule): e.g. (a) patch the same domain but make `check.sh` framework-agnostic (accept either `unittest` or `pytest` output), (b) same domain but make `task.md` explicitly specify `unittest.TestCase`, (c) a different domain/task entirely. Validate the new fixture with `validate_tasks.py` before running the real loop on it.
3. **Resume the fix-fail-fast loop** on the new fixture, applying the §2 standing instruction throughout — not just to the one nudge fixed in step 1, but to any other generic-recovery-message gap you find along the way.
4. Continue logging every cycle in both `ITERATION_LOG.md` and `PROGRESS.md`, per the format already established.

---

## 5. Quick reference

```bash
# Confirm state
npm run typecheck && npm test && npm run compile
git log --oneline -10 && git status --short && git branch --show-current
pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"

# The MLX-4bit snapshot (Ornith only)
S4=$(ls -d ~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/*)

# One cycle's run, workspace kept for inspection, watched live
node _devtools/run-ts.js _devtools/bench/run_task.ts \
  --task <your-new-task-id> --provider mlx --model "$S4" \
  --thinking auto --terse true --out _devtools/e2e/results/<task>-mlx4bit-cycle<N>.json \
  --timeout-s 600 --max-iters 40 --keep > /tmp/t0N-cycleN.log 2>&1 &

# Summarize the trace
python3 _devtools/bench/trace_report.py _devtools/e2e/results/<task>-mlx4bit-cycle<N>.trace.jsonl
```

**Read the full message transcript (`.messages.json`), not just the trace summary, before concluding anything** — that's how root cause #2 in this hand-off was actually found; the trace alone made it look like a plain repeat of the old "model limitation."

Good luck.
