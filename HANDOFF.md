# Hand-off — Forge v0.15.0-work

**Last updated:** 2026-10-03 (overwritten at this pause). If this file and `PROGRESS.md` / `git log` disagree, trust `PROGRESS.md` and `git log`.

## State

- Repo `Local LLM Tools/forge`, branch `v0.15.0-work`, HEAD `dc3fca0` (plus the docs commit that adds this file). **Not pushed** since `7898da9`. Never commit to or push `main`/`master`, and push only when the owner asks.
- Revert point before the frameworks work: git tag `pre-frameworks-2026-10-03` (= `86b1995`). Docs-only changes after it.
- Clean tree except one untracked file, `_devtools/bench/req-ab-round2.log` (owner has not said commit or ignore).
- Tests: `node _devtools/run-tests.js` → 55 files, 1,953 checks, all pass. Typecheck clean. Nothing is running.
- Test model: gpt-oss-20b MXFP4-Q8 on MLX only. **Live tests are on HOLD** — do not load any model until the owner says the hardware is free.
- `package.json` version still 0.14.0.

## Done (2026-10-03, owner's six additions)

| Item | What | Commit |
|---|---|---|
| 2 | Context meter counts the whole prompt (cache included) | 4712970 |
| 3 | Empty / "I'll now…" replies are nudged, not accepted as final | bd0dca1 |
| 6 | `search_code` is a ripgrep-backed grep (flags, scopes, files/count/extract) | f78b1ff |
| 1 | Message queue + steer while the agent works | 02960c9 |
| 4+5 | Cursor→Forge file-mailbox bridge (`forge.bridge.enabled`, **default off**) | dc3fca0 |

Earlier work (2026-09-28..30: large-file fix, generous limits, machine profile, caching, requirements checklist default OFF, verify-before-done, two audits) is in `PROGRESS.md` and `CHANGELOG.md`.

## Open items

1. Owner questions: bridge on by default? commit or ignore the stray log? push?
2. Live tests, in `PENDING_TESTS.md`: LIVE-001 (requirements A/B round 3), then LIVE-002..005, new LIVE-006 (meter + stalled-reply), LIVE-007 (queue in the real panel), LIVE-008 (mailbox bridge end to end).
3. After LIVE-001, recommend whether `forge.requirements.enabled` stays off by default.
4. Known limits: steering text is not a requirements source; "Send now" does not cancel an in-flight model call; the stalled-reply cause is from code reading and is unconfirmed live.
5. Re-run the owner's docs task on the M5 Max.

## Resume order

1. Read `CLAUDE.md`, `USER_BRIEF.md`, `DECISIONS.md` (open: D-015), this file, `PROGRESS.md` ("Next"), `docs/HARNESS_REFERENCE.md`, `PENDING_TESTS.md`, `KNOWLEDGE_BASE.md`.
2. `git status` and `git log -3` to confirm the state above.
3. Ask the owner whether the hardware is free. If yes, start LIVE-001 (memory-safe: one model, check free memory and swap, stop at the first failure).
4. Give a status update every 45 minutes even when idle; state the remaining token count before any long or background run (`CLAUDE.md` rule 7).

## Working method

- Claude directs and reviews; Cursor does large tasks: `bridge wake cursor "<task>" --model grok-4.7-high` (hard) or `composer-2.5` (well-specified); model flag after the task; never `-fast`/`auto`. Read replies with `bridge read claude`. If a wake fails with "Connection stalled", retry once. If Cursor is out of usage, use a Claude sub-agent. Always review the diff; never accept a weakened test.
- Cost-aware (global rule, 2026-10-03): do small work yourself; delegate only large work. Worker runs are logged in `logs/AGENT_USAGE.md`.
- Harness fixes must be universal (any model, any task).
- Keep replies short and plain.

## Keep this file current

Overwrite it at every pause or milestone, together with `PROGRESS.md`.
