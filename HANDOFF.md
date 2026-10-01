# Hand-off — Forge v0.15.0-work

**Last updated:** 2026-09-30. For a new agent or a new machine. If this file and `PROGRESS.md` / `git log` disagree, trust `PROGRESS.md` and `git log`.

## State

- Repo: `Local LLM Tools/forge`. Branch: `v0.15.0-work`. HEAD before this docs commit: `3849dd7`.
- Pushed to origin: yes (`v0.15.0-work` was in sync with `origin/v0.15.0-work` when this was written; the docs commit that adds this file is not pushed). Never push or commit to `main`/`master` unless the owner asks.
- `package.json` version is still 0.14.0 (not bumped).
- Test model: gpt-oss-20b MXFP4-Q8 (MLX) only. See `CLAUDE.md` standing rules (rule 10: generous limits for the M5 Max 128 GB).

## How to resume

Read, in order: `CLAUDE.md`, `PROGRESS.md`, `docs/HARNESS_REFERENCE.md`, `PENDING_TESTS.md`. Also `KEEP_AWAKE.md` (how to keep the Mac awake for long agent runs).

## What was done 2026-09-28 to 2026-09-30

- **Large-file write truncation fix:** auto output cap derived from the context window, `write_file` `append:true`, and a nudge that tells the model not to resend the whole file (3524a51).
- **Owner rule 10 (generous limits):** bigger defaults for the M5 Max 128 GB (context 131072, file size, chunks, caches, output caps) and a new `forge.maxOutputTokensCeiling` setting (506dfdb, 76cccfb).
- **Machine profile + recommendations:** the Settings panel shows a read-only machine profile and recommended values, with Apply (d10edba, 9aea0a0).
- **Caching:** stable prompt prefix, caching/speed settings for MLX and Ollama, and an MLX benchmark: about 97% cache hit and about 15x faster prefill on append steps (bcee0dc, 4f5cc36).
- **Requirements checklist:** default OFF. The A/B showed a cost (more nudges, lower cache hit, longer runs). A cache bug was fixed in bcd8a8a. Round 3 is pending (see LIVE-001).
- **Tool-argument fixes:** `read_file` line_start/line_end, nested tool unwrap, argv-style `run_command` (a33aaa9 and nearby commits).
- **Verify-before-done:** auto-detects `check.sh`, `npm test`, `pytest` and similar; guards user acceptance commands (4039055, de94213).
- **Pinned user messages** now survive compaction (4039055).
- **Two harness audits and all their fixes:** 9aea0a0, c42aeb7, 4b6bbf4, fd05aac, 3849dd7. Reports: `docs/HARNESS_REFERENCE.md`, `_devtools/bench/results/2026-09-30-second-audit.md`.
- **Loop-detector regression** caught and fixed (2bc0387: only reads of new ranges are exempt).
- **Zero maxTokens bug** fixed (b24795c): it had dropped MLX to its 512-token default.
- `forge.requirements.llmExtract` was removed (it was never implemented).

## Open items

1. `PENDING_TESTS.md` LIVE-001 to LIVE-005 are all pending. Round 3 (LIVE-001) is on hold by the owner until the hardware is free.
2. Decide the default of `forge.requirements.enabled` after LIVE-001.
3. Re-run the owner's docs task on the M5 Max.

## Working method

- Claude orchestrates and reviews; Cursor (composer-2.5) does large tasks via `bridge wake cursor "<task>" --model composer-2.5`. Read replies with `bridge read claude`. Always review Cursor's diff (`git show <hash>`).
- Cost-aware (owner, 2026-09-30): do small work yourself; delegate only large work where it is cheaper. Cursor usage ran out on 2026-09-30 (Opus resets 10/11); fallback for large work: a Claude sub-agent.
- Harness fixes must be universal (any model, any task). The model fixes its own mistakes; the harness gives clear, accurate messages.
- Keep replies short and plain. State the remaining token budget before any long or background run (`CLAUDE.md` rule 7).

## Keep this file current

Update it at the end of every session or major milestone, together with `PROGRESS.md`.
