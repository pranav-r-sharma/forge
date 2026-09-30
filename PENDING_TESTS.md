# Pending live tests (need hardware / MLX model)

Tests listed here require loading **gpt-oss-20b MXFP4-Q8 (MLX)** per `CLAUDE.md` rule 0.2c. Run only when the Mac is free for model work. Follow rule 4 (one model at a time, check memory/swap, abort on pressure). Mark **done** with date and a result path when complete.

| ID | Title | Status | Added |
|----|-------|--------|-------|
| LIVE-001 | Round 3 — requirements checklist A/B after cache fix bcd8a8a | pending | 2026-09-30 |
| LIVE-002 | Verify-before-done auto picks `bash check.sh` on t09/t11 | pending | 2026-09-30 |
| LIVE-003 | Pinned user follow-ups survive compaction in a long run | pending | 2026-09-30 |

---

## LIVE-001 — Round 3 requirements checklist A/B after cache fix bcd8a8a

**Why:** Re-validate prompt-cache hit rate and harness overhead after requirements checklist + cache fixes (commit bcd8a8a). Round 2 was cut by SIGTERM; runner must survive bridge disconnect.

**How:**

1. One model loaded at a time; MLX snapshot:
   `~/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3`
2. From repo root, run detached (so SIGTERM from a session does not kill the matrix):

```bash
cd "/Users/pranavsharma/Code Projects/Local LLM Tools/forge"
nohup bash _devtools/bench/run_req_ab_round2.sh > _devtools/bench/req-ab-round3.log 2>&1 &
echo $! > _devtools/bench/req-ab-round3.pid
```

Equivalent per task via `run_task.ts`: `--requirements true|false`, tasks **t11-checklist** and **t09-harder-build**, **2 reps** each, `--provider mlx`, `--thinking auto`, `--terse true`, `--append-only true`.

**Pass criteria:**

- With requirements **on**, prompt-cache hit ratio close to requirements **off** (~89% / ~95% baseline from prior rounds — record actual numbers).
- Wall-time overhead of req-on vs req-off documented.
- Nudge counts, grader pass, no false-done on passing runs.
- All 8 runs complete (`ROUND2_COMPLETE` in log or 8 result JSONs under `_devtools/e2e/results/req-ab2-*.json`).

**Prerequisites:** M5 class Mac, memory-safe rules; unload other models first; note free RAM and swap in the log.

---

## LIVE-002 — Verify-before-done auto selects `bash check.sh` on t09/t11

**Why:** Confirm fix 4/5 behavior in a real agent turn: `verifyBeforeDone: auto` must run `bash check.sh` on e2e tasks **t09-harder-build** and **t11-checklist**, and the final bubble must show verify pass.

**How:**

1. MLX model as above; `forge.verifyBeforeDone` = `auto`, requirements off unless testing checklist separately.
2. Run one successful e2e pass each (or inspect a passing req-ab result): `node _devtools/run-ts.js _devtools/bench/run_task.ts --provider mlx --model "$MODEL" --task t09-harder-build --max-iters 80 --timeout-s 1200 --out _devtools/e2e/results/live-verify-t09.json`
3. Repeat for `t11-checklist` (lower max-iters ok if grader passes).

**Pass criteria:**

- Trace or transcript shows verify command `bash check.sh` (or detected equivalent) before `done`.
- Final event includes verify success / `Verify: pass` in UI terms (`verifyOk: true` in trace).
- Grader passes.

---

## LIVE-003 — Pinned user follow-ups survive compaction in a long run

**Why:** Confirm pinned user messages (e.g. mid-task corrections) remain verbatim after compaction during a long auto turn.

**How:**

1. MLX model; enable compaction (`context.appendOnly` true, large task or forced many steps).
2. Use a task or harness script that injects a distinctive pinned user follow-up mid-run, then exceeds compaction high-water (monitor `estPromptTokens` / compact events in trace).
3. After compaction, model still sees the pinned phrase in prompt view (grep trace JSONL or `.messages.json` export).

**Pass criteria:**

- Pinned follow-up text appears in post-compaction prompt messages (not only in archival summary stub).
- Turn completes without losing the instruction.

**Note:** May combine with a scripted long `_devtools/e2e` run once a dedicated compaction stress task exists; until then manual trace inspection is acceptable.
