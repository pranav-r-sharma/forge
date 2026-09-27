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

# Iteration log — t08-five-file-build loop

## Cycle 1 — Ornith MLX-4bit

- **Run:** t08-five-file-build, MLX-4bit/Ornith-1.5-9B, thinking=auto terse=true, max-iters 40, timeout-s 600
- **Result:** FAIL — 5 iterations, 114.5 s wall, no files written
- **Classification:** harness bug (model omitted one closing brace in an otherwise complete reply; harness misreported it as "cut off" so the model resent identical bytes; iteration cap then ended silently as a normal final answer)
- **Finding:** The model's `write_file` JSON was missing a single closing `}` — a real model error, not a length cutoff. The harness used cut-off wording anyway, the model repeated the same broken payload, and after the nudge cap the run stopped without surfacing the actual parse failure.
- **Fix:** `3458397` + `64d4205` — specific invalid-JSON message naming tool/path/parse error; cut-off wording only for real cut-offs; explicit failure when the cap is hit; no auto-repair (owner: model fixes its own JSON).
- **Evidence:** `_devtools/e2e/results/t08-five-file-build-mlx4bit-cycle1.{json,trace.jsonl,messages.json}`, `_devtools/e2e/results/t08-cycle1.log`
- **Next:** switch test model to gpt-oss-20b MXFP4-Q8 (MLX), smoke test, then t08 cycle 2

## gpt-oss-20b MXFP4-Q8 smoke (t01) — runs 1–4

- **Smoke 1:** FAIL, 1 iter, 10.1 s — Harmony `to=run_command` native call not executed; fix `aa81276` (foreign-format nudge + Harmony channel handling).
- **Smoke 2:** FAIL, 1 iter, 5.8 s — mlx_lm.server 404 on replay when `<|channel|>` leaked into stored history; fix `7548178` (`assistantContentForHistory` strips Harmony; test runner counts).
- **Smoke 3:** FAIL, 5 iters, 13.6 s — valid native calls still nudged instead of executed; fix `8c41833` (accept exact native tool calls; cap consecutive foreign failures).
- **Smoke 4:** PASS, 13 iters, 16.0 s — t01-fix-bug end to end after smoke 1–3 fixes.
- **Evidence:** `_devtools/e2e/results/smoke{,2,3,4}-gptoss-q8-t01.*`

## Cycle 2 — gpt-oss-20b MXFP4-Q8 (MLX)

- **Run:** t08-five-file-build, gpt-oss-20b MXFP4-Q8 (MLX snapshot), thinking=auto terse=true
- **Result:** PASS — 27 iterations, 124.7 s wall, all 5 code files written first try; `py_compile` on models/storage/reports/cli + `main.py demo` + add/list with new db all exit 0; `check.sh` pass
- **Classification:** success with recorded findings (not blockers)
- **Findings:** (a) **Model limitation** — final answer overclaims: says all five files compile and summary works but never ran `py_compile` on `main.py` nor `summary` (true per `check.sh`, unverified in transcript); possible future harness idea: verify commands named in the final answer were run this turn. (b) **Harness inaccuracy (msg 24–25)** — empty native `to=forge_action {}` nudged as “not a Forge tool”; fixed `805c115`.
- **Evidence:** `_devtools/e2e/results/t08-five-file-build-gptossq8-cycle2.{json,trace.jsonl,messages.json}`
- **Next:** t08 cycle 3 (need 2 consecutive clean passes)
