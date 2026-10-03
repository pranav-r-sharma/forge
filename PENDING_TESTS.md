# Pending live tests (need hardware / MLX model)

Tests listed here require loading **gpt-oss-20b MXFP4-Q8 (MLX)** per `CLAUDE.md` rule 0.2c. Run only when the Mac is free for model work. Follow rule 4 (one model at a time, check memory/swap, abort on pressure). Mark **done** with date and a result path when complete.

| ID | Title | Status | Added |
|----|-------|--------|-------|
| LIVE-001 | Round 3 — requirements checklist A/B after cache fix bcd8a8a | pending | 2026-09-30 |
| LIVE-002 | Verify-before-done auto picks `bash check.sh` on t09/t11 | pending | 2026-09-30 |
| LIVE-003 | Pinned user follow-ups survive compaction in a long run | pending | 2026-09-30 |
| LIVE-004 | MLX server restarts when `forge.mlx.contextTokens` / panel context changes (managed server) | pending | 2026-09-30 |
| LIVE-005 | MLX settings change mid-agent-turn defers restart until turn ends (status + no in-flight `chat()` break) | pending | 2026-09-30 |
| LIVE-008 | File mailbox bridge end to end: Cursor `forge-bridge ask` -> Forge chat -> reply | pending | 2026-10-03 |
| LIVE-007 | Queue + steer in the real panel: send while busy, steer lands at next step, Edit/Remove/Send now, Stop keeps queue, reload restores queue | pending | 2026-10-03 |
| LIVE-006 | Context meter tracks real prompt size; stalled-reply nudge fires and is not a false positive | pending | 2026-10-03 |

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

---

## LIVE-004 — MLX server restarts when context window changes (managed server)

**Why:** `forge.mlx.contextTokens` (and the settings panel “Context window” via `numCtx` remap when provider is MLX) must reload `mlx_lm.server` with the new `--ctx-size`. Forge-only compaction math is not enough — the running server must match.

**How:**

1. One model at a time; MLX provider with managed `mlx.autoStart` (default). Use gpt-oss-20b MXFP4-Q8 snapshot per `CLAUDE.md` 0.2c if exercising a real model load.
2. Note current `forge.mlx.contextTokens` (e.g. 131072). Confirm server healthy (`Forge: MLX` status / `curl` health on `forge.mlx.baseUrl`).
3. Change context in VS Code settings or panel (e.g. 65536), save.
4. Observe: previous managed child receives SIGTERM; new server starts with updated ctx in `mlxServer.ts` ensure key (`test_v15_mlxserver.ts` `testRestartAdoptSerialize` covers unit behavior).

**Pass criteria:**

- Managed MLX process restarts (not silent Forge-only update).
- New server accepts chat with the new context limit (no stale ctx errors).
- Unit test `changing forge.mlx.contextTokens restarts the managed server` still passes in CI (`npm test`).

**Prerequisites:** MLX venv `_devtools/mlx-venv`; rule 4 memory safety — unload other models, check free RAM/swap before load; abort on pressure.

**Status:** pending  
**Date:** —

---

## LIVE-005 — MLX settings change mid-turn defers restart until turn ends

**Why:** Changing MLX server keys during an active agent turn must not SIGTERM the server under an in-flight `chat()` call. Restart should defer and surface “MLX restart pending…” until the turn completes.

**How:**

1. MLX provider; start a long agent turn (e.g. e2e task with high `max-iters` or a harness that holds the turn open across several model calls).
2. Mid-turn, change a restart-triggering setting (`forge.mlx.promptCacheGB`, `forge.mlx.contextTokens`, draft model, etc.) via settings UI.
3. Watch status bar and logs: restart must **not** run until the turn ends.
4. End or cancel the turn; restart should run once (`mlxRestartCoord.ts`).

**Pass criteria:**

- While `activeAgentTurnCount() > 0`, `requestMlxRestartAfterSettingsChange()` sets pending but does not call ensure (see `test_v15_second_audit_fixes.ts` `testMlxRestartDeferral`).
- No failed mid-turn chat from server disappearance; after turn end, server matches new settings.
- Status bar indicates pending restart during the deferral window (manual UI check).

**Prerequisites:** Same as LIVE-004 for real MLX; rule 4 memory safety.

**Status:** pending  
**Date:** —

## LIVE-006 — Context meter + stalled-reply nudge (2026-10-03)

- **Why:** fixes for owner reports (meter always low; agent stops abruptly). Unit/fake-model tests pass; needs a real model.
- **How:** gpt-oss-20b MXFP4-Q8 on MLX. Run t07-build-from-scratch and one long chat in the UI.
- **Pass:** meter % rises across tool calls and roughly matches trace `promptTotalTokens`/context; trace `announced-action-nudge`/`empty-reply-nudge` notes appear only on genuine stalls (read each one); no run ends on an "I'll now…" reply.

## LIVE-007 — Queue + steer in the real UI (2026-10-03)

- **Why:** the webview and VS Code panel cannot be driven by the unit tests (48 checks cover the logic and fake-model loop only).
- **How:** open Forge in VS Code, start a multi-step Agent task (gpt-oss-20b MXFP4-Q8 on MLX), type a follow-up and press Enter while it runs.
- **Pass:** message appears in the queue list; model acknowledges it at its next step (transcript shows "sent mid-turn"); Edit/Remove/Send now work; Stop keeps the queue and does not auto-send; reloading the window restores the queue; Ask/Plan mode leaves it queued until the turn ends.

## LIVE-008 — File mailbox bridge, end to end (2026-10-03)

- **Why:** the watcher and mail format are unit-tested; the real VS Code panel, tool approvals and a real model are not.
- **How:** set `forge.bridge.enabled` true in VS Code on this repo (status bar shows "Forge bridge listening"). From a terminal: `_devtools/bridge/forge-bridge ask "hello" "Reply with the word ok" --mode ask`, then a small Agent task that writes a file, then `@session <id>` follow-up, then `bridge send cursor forge ...` plus `bridge read cursor`. gpt-oss-20b MXFP4-Q8 on MLX only.
- **Pass:** each task shows as a "[bridge] ..." chat in the panel, a reply file lands in `.agent-bridge/inbox/cursor/` with status done and the right session id; a task needing approval waits in the panel; reloading VS Code mid-task reruns the file from processing/; turning the setting off stops the watcher.
