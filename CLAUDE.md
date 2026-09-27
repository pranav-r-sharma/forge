# Forge — instructions for the coding agent

Forge is a VS Code extension (TypeScript, **zero runtime npm dependencies**) that gives a local, agentic coding assistant on a Mac. Current version 0.14.0; the v0.15.0 plan lives in `v0.15.0 suggestions.md`.

**Source of truth for status:** `PROGRESS.md` (read it first, every session). **Source of truth for the plan and reasons:** `v0.15.0 suggestions.md`.

## Standing rules (from the owner — do not relax)

1. **Ornith only for testing.** All testing, benchmarking and A/B use **Ornith-1.5-9B** and no other model. The only variables are runtime (Ollama vs MLX) and quantization. See "0.2c" in the plan.
2. **Development STARTED 2026-09-26** (owner said "go start"). Work through the plan in `PROGRESS.md` in order, thoroughly: test constantly, monitor performance and efficiency, iterate. Efficiency is paramount.
3. **Installs:** the owner approved installing **MLX** on 2026-09-26 — a **project-local venv** (`_devtools/mlx-venv`, gitignored) with a **pinned** `mlx-lm`, user-level only (no sudo), load the Ornith snapshot **offline** with `trust_remote_code` **off**. Ask before any *other* install/download (brew, another Python, more models).
4. **Memory-safe testing on this Mac (M5, 32 GB).** One model loaded at a time; unload before the next; check free memory and swap before loading; abort on pressure. Never push to a crash. Record hardware in every result.
5. **Work on branch `v0.15.0-work`.** Commits are allowed there (owner approved 2026-09-26). Do not commit to `master`/`main`. Never push or force-push without being asked.
6. **No `sudo` in anything that ships.** Product code, setup steps and features must work for a normal user without administrator rights. `sudo` is allowed only for the developer's own investigation during development (e.g. cross-checking with `powermetrics`), and never in committed product code or docs a user follows. Read system limits; never change them.
7. **Context-limit timer (owner rule, 2026-09-26).** When about to reach the context limit (remaining budget under ~20% or the next step is big): finish/safely stop the step, update `PROGRESS.md`, commit, then **set a 45-minute timer, cease all activity, and resume from `PROGRESS.md` when it fires.** Say so to the user before pausing.
   - **Enforcement (owner correction, 2026-09-27 — this was missed once and must not be again):** this session cannot see the account's plan usage limit, only its own remaining token count, and nothing here runs a check automatically — it only happens if tied to a concrete trigger and stated out loud. So: **state the remaining-token count in the reply, every time**, at each of these triggers (not from memory, not "I'll remember"):
     - immediately before launching any background/long-running process (a suite run, a matrix run, anything backgrounded);
     - every time a `Monitor` watcher re-arms after its 30-minute expiry (that notice is a free, automatic checkpoint — never re-arm silently);
     - before starting a new P0/major step from `PROGRESS.md`.
   - A background operation that repeats (a matrix/suite of runs) **stops at the first failure** to diagnose it, never runs the remaining reps on a setup already shown broken — this is separate from the budget rule but was also missed once (2026-09-27, 6 wasted MLX runs behind one `pkill` that didn't match the actual server process). Diagnose, fix, confirm the fix with one run, then resume the rest.
8. **Final acceptance test:** create a test repo *inside this repo* (`_devtools/e2e/`), have the harness (on Ornith) write a multi-file program in it, monitor the run, and keep improving the harness until it works well.
9. **Accuracy over completeness for measurements.** A missing number is fine; a wrong number is not. Report failures and skipped steps faithfully.

## Dev cycle — work so a usage-limit cutoff never loses progress

You cannot see plan usage limits. Assume a cutoff can happen at any time. Work so that a cutoff costs at most the current small step.

### Before starting
- Read `PROGRESS.md` and resume from **Next**. If it does not exist, create it with: Goal, Plan (numbered steps), Done, Next, Open questions.
- Split the task into small steps, each finishable in a few minutes. Split any step likely to run over ~10 minutes.

### After EVERY finished step
- Run the relevant tests or checks for that step.
- Update `PROGRESS.md`: move the step to Done, write the exact Next action, list files touched.
- Commit with a clear message (on the work branch). One step per commit; never batch steps. Never leave the repo broken between steps.

### Watch the budget
- Check the remaining context token count before each large step.
- If under ~20% of the total, or the next step is big: finish or safely stop the current step, update `PROGRESS.md`, commit, and tell the user: "Budget is low. Progress saved. Resume from PROGRESS.md."
- Do not start a large step you might not finish.

### If interrupted or resumed
- Trust `PROGRESS.md` and `git log` over memory. Check `git status` and `git diff` for half-done work; finish or revert it before moving on. Do not redo steps listed as Done.

### PROGRESS.md format
Goal (one line) · Done (bullets, one per finished step) · Next (the single next action, specific enough to start cold: file names, command) · Open questions / blockers · Last updated (date and time).

### Rules
- Keep updates short. No chat transcripts or secrets in `PROGRESS.md`.
- Do not delete or overwrite work you have not read.
- Report faithfully: if a test fails or a step is skipped, say so in `PROGRESS.md`.

## Repo notes
- Source in `src/`; tests are ad-hoc `ts-node` scripts in `_devtools/runtime_test/` (they import `vscode`, which needs a stub module not present in this checkout — restoring it is plan step P0-1). No `npm test` yet.
- Typecheck: `npm run typecheck`. Build: `npm run compile`.
- Benchmark/probe scripts live in `_devtools/bench/` (Python, standard library only).
