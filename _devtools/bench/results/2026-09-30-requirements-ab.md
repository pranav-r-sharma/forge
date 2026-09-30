# Requirements checklist A/B — live e2e (Task H)

**Date:** 2026-09-30  
**Hardware:** Apple M5, 32 GB  
**Model:** gpt-oss-20b MXFP4-Q8 (MLX snapshot `773a7da77e569019bb0fd17a554b263738d669a3`)  
**Harness:** `run_task.ts` — `thinking=auto`, `terse=true`, `appendOnly=true`, temp 0; t11 `max-iters=50` / `timeout-s=900`; t09 `max-iters=80` / `timeout-s=1200`  
**Configs:** `forge.requirements.enabled=true|false` (only variable); 2 reps per cell.  
**Raw JSON/trace:** `_devtools/e2e/results/req-ab-{task}-{req-on|req-off}-r{1|2}.json` (+ `.trace.jsonl`, `.messages.json`, t09 `.log`).

## Per-run table

| Task | Req on | Rep | Grader | Req total | Done | Open | Req nudges | False done | Tool steps | Trace records | Wall (s) | Cache hit % | Mem avail before→after (GB) | Min avail (GB) |
|------|--------|-----|--------|-----------|------|------|------------|------------|------------|---------------|----------|-------------|-----------------------------|----------------|
| t11-checklist | on | 1 | PASS | 10 | 7 | 3 | 2 | no | 9 | 21 | 77.4 | 71.6 | 17.9→7.3 | 7.2 |
| t11-checklist | on | 2 | PASS | 10 | 7 | 3 | 2 | no | 9 | 21 | 76.1 | 71.6 | 20.6→7.5 | 7.4 |
| t11-checklist | off | 1 | PASS | — | — | — | 0 | no | 9 | 20 | 40.7 | 89.2 | 20.9→7.6 | 7.6 |
| t11-checklist | off | 2 | PASS | — | — | — | 0 | no | 9 | 20 | 38.1 | 89.2 | 20.7→8.1 | 8.1 |
| t09-harder-build | on | 1 | PASS | 22 | 16 | 6 | 2 | no | 32 | 73 | 801.8 | 34.2 | 21.1→8.5 | 2.0 |
| t09-harder-build | on | 2 | PASS | 22 | 16 | 6 | 2 | no | 43 | 96 | 959.0 | 32.7 | 24.6→7.0 | 7.0 |
| t09-harder-build | off | 1 | PASS | — | — | — | 0 | no | 25 | 53 | 237.8 | 94.7 | 23.8→8.0 | 8.0 |
| t09-harder-build | off | 2 | PASS | — | — | — | 0 | no | 25 | 53 | 238.0 | 94.7 | 23.7→8.5 | 8.5 |

Medians: **t11** req-on 76.8 s vs off 39.4 s (same 9 tool steps; +2 nudges when on). **t09** req-on 880.4 s / 37.5 tool steps vs off 237.9 s / 25 tool steps.

## Conclusions

1. **Missed instructions / grader:** In this slice, **no false-done finals** (0/8): every run that emitted a final answer passed `check.sh`. Requirements on did not change pass rate (8/8 both arms); t09 **off** also passed 2/2 here (unlike pre-checklist cycle 5 failures on the same model), so this A/B is not a before/after on historical t09 failure modes—only a paired comparison today.

2. **Requirements on — benefits:** On **t11**, the model produced an explicit **Requirements:** self-report in finals when on; nudges fired twice per run (gate cap). On **t09**, checklist extraction surfaced **22** items and **2** gate nudges per run, with long verification-heavy trajectories (many `run_command` / heredoc checks).

3. **Requirements on — costs:** **~2× wall time on t11** with **lower prompt-cache hit** (~72% vs ~89%)—consistent with a growing checklist tail in the prompt view. On **t09**, **~3.7× wall time**, **more tool steps**, and **much lower cache hit** (~33% vs ~95%): the checklist + longer context dominated prefill. Memory pressure was worse on req-on t09 (min available **2.0 GB** on r1, swap growth in trace).

4. **Tracker vs grader:** With requirements **on**, finals still showed **open checklist items** at session end (t11: 3/10 open; t09: 6/22 open) even when the grader **passed**—judgment items and strict evidence rules are not fully aligned with `check.sh` success.

5. **Noisy / wrong checklist:** t09 item count (22) is plausible for `task.md`; no new incorrect file paths observed in nudge text. Open items at pass suggest **false “open” state** more than false extraction.

## Harness bugs observed (not fixed)

- `read_file` still accepts `line_start` / `line_end` silently (ignored; hint says `start_line`) — wasted full-file reads on t09 req-on.
- Model still occasionally sends **nested** `{"tool":"run_command","args":{...}}` inside `args` (rejected; extra step).
- `run_command` with **array** `command` and bogus `timeout` key — confusing error, failed step (t09 off).
- **Requirements state at end** understates “done” vs grader pass (open counts above).
- `run_task.ts` had no `--requirements` flag before this run; added for the matrix (see commit).

## PROGRESS note

Live A/B complete for t11 + t09. Default `forge.requirements.enabled=true` trades speed/cache efficiency for nudges + self-report on these tasks; no false-done reduction measured in this all-pass matrix.
