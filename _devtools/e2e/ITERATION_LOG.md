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

## Cycle 3 — gpt-oss-20b MXFP4-Q8 (MLX)

- **Run:** t08-five-file-build, gpt-oss-20b MXFP4-Q8 (MLX snapshot), thinking=auto terse=true
- **Result:** PASS — 27 iterations, 116.0 s wall, 6 `write_file` + 8 `run_command`, 0 tool failures, 0 nudges; `check.sh` pass; this run also exercised `summary` (cycle 2 did not)
- **Classification:** success — loop stop condition met (2 consecutive clean passes on t08, cycles 2 and 3)
- **Findings:** **Model limitation (recurring, 2/2 cycles)** — final answer still claims all five files compile without ever running `py_compile` on `main.py` in the transcript. **Open gap:** no t08 run so far produced a code error, so the fix-an-error path was not exercised by this fixture.
- **Evidence:** `_devtools/e2e/results/t08-five-file-build-gptossq8-cycle3.{json,trace.jsonl,messages.json}`
- **Next:** owner to choose the next test (e.g. a harder multi-file task where errors are likely, or a task seeded with bugs)

# Iteration log — t09-harder-build / t10-seeded-bugs (gpt-oss-20b MXFP4-Q8)

**Claim-checker (2026-09-27):** commits `6e5c13b`, `2c3119d` — final answers citing shell commands or universal compile claims get one `claimed-command-nudge` before accept; leftovers attach to `unverifiedClaims`.

**Tasks added:** `t09-harder-build` (`81def7f`), `t10-seeded-bugs` (`3421254`).

## t09-harder-build — Cycle 1 — gpt-oss Q8 (MLX)

- **Result:** FAIL — 25 iterations, 158 s wall, `checkExit` 1 (SyntaxError in `inventory/cli.py` unmatched `)`)
- **Classification:** harness gaps (fixed `ba01527` before cycle 2)
- **Findings:** Harmony call on analysis channel `to=repo_browser.open_file` accepted as final; final allowed over failed demo + later edit broke `cli.py`; vague "Missing required arg" for array command.
- **Evidence:** `_devtools/e2e/results/t09-harder-build-gptossq8-cycle1.{json,trace.jsonl,messages.json}`
- **Next:** cycle 2 after harness fixes

## t10-seeded-bugs — Cycle 1 — gpt-oss Q8 (MLX)

- **Result:** PASS — 39 iterations, 341 s wall, 0 check failures; model found and fixed all 5 planted bugs from reading code
- **Findings:** one `truncated-reply-nudge` (long analysis, iter 7); array-command error self-corrected; 2 tool failures total
- **Evidence:** `_devtools/e2e/results/t10-seeded-bugs-gptossq8-cycle1.{json,trace.jsonl,messages.json}`
- **Next:** cycle 2 confirmation run

## t09-harder-build — Cycle 2 — gpt-oss Q8 (MLX)

- **Result:** FAIL — 70 iterations, 363.5 s wall, `checkExit` 2 (`check.sh`: `main.py` rejects `--db` on subcommands — global vs per-command argparse)
- **Classification:** model/task (CLI `--db` placement); harness behaved (array-command errors self-corrected; `claimed-command-nudge` iter 31; `foreign-tool-call-nudge` iter 20)
- **Evidence:** `_devtools/e2e/results/t09-harder-build-gptossq8-cycle2.{json,trace.jsonl,messages.json,log}`; workspace `--keep`: `/var/folders/6_/0y34b0x51zlcndfh0zqcxknm0000gn/T/forge-e2e-t09-harder-build-Az2Tn6`

## t10-seeded-bugs — Cycle 2 — gpt-oss Q8 (MLX)

- **Result:** PASS — 43 iterations, 354.1 s wall; 2 consecutive passes (cycles 1–2) — **t10 done**
- **Findings:** `truncated-reply-nudge` iter 7 (same as cycle 1); 2 tool failures; 0 agentError
- **Evidence:** `_devtools/e2e/results/t10-seeded-bugs-gptossq8-cycle2.*`; workspace `--keep`: `.../forge-e2e-t10-seeded-bugs-FgdJuT`

## t09-harder-build — Cycle 3 — gpt-oss Q8 (MLX)

- **Result:** FAIL — 122 iterations, 896.9 s wall, `checkExit` 1 (`inventory/cli.py` `NameError: name 'args' is not defined`); **agentError** loop hard-stop (no prior warning)
- **Classification:** model + harness gaps (fixed after this run: unknown `line_start`/`line_end` on `read_file` ignored silently; loop detector stopped cold on 3× identical `write_file`)
- **Findings:** `task-command-nudge` / **`115a52b`** task-form checker helped — model used spec CLI forms and started fixing; then thrashed on `cli.py`. Cycle 2 checker fix **`375d40c`** (no false `python3 demo` compile claim; nested-action error). Cycle 2 FAIL was global `--db` vs per-subcommand spec.
- **Evidence:** `_devtools/e2e/results/t09-harder-build-gptossq8-cycle3.{json,trace.jsonl,messages.json}` (`agentError` + msgs 30–31, 44–45, 52–53, 64–65, 74–77, 86–87, 120–131)
- **Next:** t09 cycle 4 after unknown-arg + loop-warn harness commits

## t09-harder-build — Cycle 4 — gpt-oss Q8 (MLX)

- **Result:** FAIL — 120 iterations, 764 s wall, loop stop after 2 loop-warnings; `check.sh` IndentationError `inventory/cli.py:149`
- **Classification:** harness bug — `write_file` whitespace-tolerant match said "No changes — already matches" on indentation-only fixes (13 wasted edits); ambiguous-match message lacked line numbers; did-you-mean suggested `cwd` for `cmd`
- **Fix:** `7186c10` — indentation-only edits applied; ambiguous-match errors name line numbers; did-you-mean prefers abbreviations (`cmd` → `command`)
- **Evidence:** `_devtools/e2e/results/t09-harder-build-gptossq8-cycle4.{json,trace.jsonl,messages.json,log}`
- **Next:** t09 cycle 5 (validate `7186c10` live)

## t09-harder-build — Cycle 5 — gpt-oss Q8 (MLX)

- **Result:** INCOMPLETE — killed by SIGTERM at 543.7 s, 61 iterations; **not a valid attempt**
- **Classification:** evidence only (run interrupted; do not count as pass/fail)
- **Findings:** checker false positive — "You ran `python3 -h` on 1 of 7 files" (`python3 main.py -h` treated as per-file check; **unfixed**); "No changes — already matches" appeared again early (verify vs byte-identical search); `task-command-nudge` fired and the model began running spec forms
- **Evidence:** `_devtools/e2e/results/t09-harder-build-gptossq8-cycle5.{json,trace.jsonl,messages.json,log}`
- **Next:** fix the false positive, re-run cycle 5 (`HANDOFF.md` §5a / §6)
