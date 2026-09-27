# Iteration log — t07-build-from-scratch autonomous fix-fail-fast loop

One short entry per loop cycle. Full narrative for each cycle stays in `PROGRESS.md`; this file is an at-a-glance index only. See `HANDOFF.md` for the loop's rules and stopping conditions.

## Cycle 1 — 2026-09-27 17:49

- **Run:** t07-build-from-scratch, MLX-4bit/Ornith-9B, thinking=auto terse=true, max-iters 40, timeout-s 600
- **Result:** FAIL — ran to the full 600s timeout (12 trace events, iterations 0-11)
- **Classification:** model limitation (recurrence of an already-recorded pattern, not a new bug)
- **Finding:** Model wrote `tests/test_storage.py` (imports `contacts.storage`) before `contacts/storage.py` existed, got a pytest collection error, and never checked whether the file existed — instead added `conftest.py` and tried `PYTHONPATH=$(pwd)` to "fix" what it diagnosed as an import-path problem. Identical shape to the two model-limitation findings already recorded in PROGRESS.md ("Confirmation rerun" entry). `contacts/storage.py` and `contacts/cli.py` were never written. Fix #1 (abandoned-mid-JSON-action retry) fired correctly and harmlessly at iteration 2 — not a bug, the safety net working as designed.
- **Evidence:** `_devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle1.{json,trace.jsonl,messages.json}`
- **Next:** rerun — one recurrence isn't yet enough to call the model-limitation floor reached; want at least one more data point before stopping the loop on that basis.

## Cycle 2 — 2026-09-27 18:01

- **Run:** t07-build-from-scratch, MLX-4bit/Ornith-9B, thinking=auto terse=true, max-iters 40, timeout-s 600
- **Result:** FAIL — `checkExit: 5` ("Ran 0 tests"), but the built program was actually correct (verified `acceptance.py` passes by hand against the kept workspace)
- **Classification:** two separate findings, not one:
  1. **Fixture defect** (not harness, not model) — `check.sh` requires `unittest.TestCase`-style tests; the model wrote valid pytest-style `def test_x()` functions instead (task.md never specified a style); `unittest discover` finds 0 of them.
  2. **Real harness gap** (owner decision: fix it, don't just log it) — the abandoned-action-nudge (`agentLoop.ts`) tells the model to take "your next action" without naming which file/action was left unfinished, so the model can (and did) drift to a different file instead of resuming the one that was cut off — the actual mechanism behind the "test written before its source file" pattern seen in 3 prior cycles.
- **Finding:** see PROGRESS.md's "cycle 2" entry for the full transcript-level trace of both findings.
- **Fix:** none yet — recorded this cycle; fixing the nudge is the next agent's first priority per the rewritten `HANDOFF.md`.
- **Evidence:** `_devtools/e2e/results/t07-build-from-scratch-mlx4bit-cycle2.{json,trace.jsonl,messages.json}`
- **Next:** stop the loop on `t07` — retire the fixture (owner decision), fix the nudge-specificity gap, design + validate a new fixture, then resume the loop on that. See `HANDOFF.md`.
