# Decisions

`D-###` entries, IDs never reused. Statuses: proposed, approved, approved (proxy), declined, superseded by D-###. Old entries are never deleted; a changed choice adds a new entry and marks the old one superseded.

**D-001 to D-011 were back-filled on 2026-10-03** from `CLAUDE.md`, `PROGRESS.md` and the global rules. The options considered at the time were not recorded then, so "Options" says so rather than inventing them.

### D-001 — Start development
Date: 2026-09-26   Status: approved
Options: not recorded.   Decision: start now (owner: "go start"). Work the plan in `PROGRESS.md` in order.

### D-002 — MLX install
Date: 2026-09-26   Status: approved
Options: not recorded.   Decision (owner): install MLX in a project-local venv (`_devtools/mlx-venv`, gitignored), pinned `mlx-lm`, user-level only, offline model load, `trust_remote_code` off. Any other install or download needs a new yes.

### D-003 — Test model: Ornith-1.5-9B only
Date: 2026-09-27   Status: superseded by D-004
Options: not recorded.   Decision: Ornith-only testing.

### D-004 — Test model: gpt-oss-20b MXFP4-Q8 (MLX) only
Date: 2026-09-27 or later (exact date not recorded)   Status: approved
Decision (owner): all testing and benchmarking uses gpt-oss-20b MXFP4-Q8 from the pinned local MLX snapshot. Variables are runtime and quantization only. Supersedes D-003.

### D-005 — Default runtime: MLX
Date: 2026-09-27   Status: approved
Decision (owner): "MLX is the actual direction — switch to it now". `forge.provider` packaged default changed from `ollama` to `mlx`. Revisit: if MLX stops being the main runtime.

### D-006 — Branching and pushing
Date: 2026-09-26   Status: approved
Decision (owner): work on `v0.15.0-work`; commits allowed there; never commit to `main`/`master`; never push or force-push unless asked.

### D-007 — No sudo in anything that ships
Date: 2026-09-26   Status: approved
Decision (owner): product code, setup steps and user docs must work without admin rights. `sudo` only for the developer's own investigation. Read system limits; never change them.

### D-008 — Target hardware and generous limits
Date: 2026-09-30   Status: approved
Decision (owner): target the M5 Max, 128 GB. Use generous limits (output tokens, context, step caps, file sizes, caches). One model at a time and memory checks still apply.

### D-009 — Cost-aware delegation
Date: 2026-09-30 (global 2026-10-03)   Status: approved
Decision (owner): do small work yourself; delegate only large work where it is cheaper; always review delegated diffs. Made a global rule in `~/.claude/rules/agent-bridge.md` on 2026-10-03.

### D-010 — Requirements checklist default OFF
Date: 2026-09-30   Status: approved (provisional)
Reason: round-2 A/B showed a cost (more nudges, lower cache hit, longer runs); a cache bug was fixed in bcd8a8a.
Revisit: after LIVE-001 (round 3). The owner asked for a recommendation then.

### D-011 — Cursor worker models
Date: 2026-10-01   Status: approved
Decision (owner, global rule): only Composer or Grok models; never `auto` or `-fast`; Cursor first, then a Claude sub-agent only if Cursor is out of usage.

### D-012 — Message queue behavior
Date: 2026-10-03   Status: approved
Options: A) queue + steer into the running turn (recommended), B) queue only, C) steer only.
Decision: A (owner). Built in 02960c9. Limits: steering text is not a requirements source; Send now does not cancel an in-flight model call.

### D-013 — How Cursor talks to Forge
Date: 2026-10-03   Status: approved
Options: A) local HTTP server + CLI (recommended), B) fully headless Forge, C) file mailbox only.
Decision: C (owner chose it over the recommendation). Built in dc3fca0. Consequence: VS Code must stay open; no live streaming.
Revisit: if the mailbox proves too slow or needs live streaming.

### D-014 — Grep tool shape
Date: 2026-10-03   Status: approved
Options: A) upgrade `search_code` in place (recommended), B) add a separate `grep` tool.
Decision: A (owner). Built in f78b1ff.

### D-015 — Bridge on by default?
Date: 2026-10-03   Status: proposed
Options: A) off by default (current), B) on by default.
Recommendation: A — any process that can write the repo could otherwise start an agent that runs commands.
The owner has not answered. It ships as A, the safe state. Nothing else depends on this choice.

### D-016 — Keep this repo's document names
Date: 2026-10-03   Status: approved (proxy: owner said "dont break anything")
Options: A) keep `PROGRESS.md` and the existing layout, add the missing framework files beside it (recommended); B) rename `PROGRESS.md` to `PROGRESS_LOG.md` and move code into `src/<package>/` and `scripts/` as the frameworks describe.
Decision: A. `PROGRESS.md` plays the role of `PROGRESS_LOG.md`. Code stays under `src/<area>/` (about 100 files and the extension's build config depend on those paths); `_devtools/` plays the role of `scripts/dev/`. B is higher risk for no gain now.
Revisit: if the owner wants the exact framework names or layout.

### D-017 — Put the project on GitHub `main`
Date: 2026-10-03   Status: approved
Finding: GitHub `main` (2 commits, 0 files: "Test: verify push access", "Remove test file", tip 6881eb8) and `v0.15.0-work` share no history, so a merge is impossible without `--allow-unrelated-histories`.
Options: 1) make `main` equal `v0.15.0-work` with a force-push (recommended; `main` held no files); 2) merge with `--allow-unrelated-histories`; 3) leave `main` alone.
Decision: 1 (owner, "1"). Done with `--force-with-lease` against 6881eb8; the old tip is kept as tag `old-main-6881eb8`. GitHub's default branch was `v0.15.0-work`; the owner then approved switching it to `main` (done 2026-10-03, `gh repo edit --default-branch main`). Work continues on `v0.15.0-work`; `main` is moved forward to it only when the owner asks.
Revisit: to undo, `git push --force-with-lease origin old-main-6881eb8:main`.
