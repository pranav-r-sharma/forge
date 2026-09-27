# Forge — instructions for the coding agent

Forge is a VS Code extension (TypeScript, **zero runtime npm dependencies**) that gives a local, agentic coding assistant on a Mac. Current version 0.14.0; the v0.15.0 plan lives in `v0.15.0 suggestions.md`.

**Source of truth for status:** `PROGRESS.md` (read it first, every session). **Source of truth for the plan and reasons:** `v0.15.0 suggestions.md`.

## Standing rules (from the owner — do not relax)

1. **Ornith only for testing.** All testing, benchmarking and A/B use **Ornith-1.5-9B** and no other model. The only variables are runtime (Ollama vs MLX) and quantization. See "0.2c" in the plan.
2. **Nothing new starts until the owner says "start".** Planning and documentation are fine; code changes and installs wait. (Owner said "start" is required; check `PROGRESS.md` → *Status* to see whether it has been given.)
3. **Ask before installing anything** (`pip install`, `brew`, downloads). The MLX venv install needs explicit approval each time it is proposed.
4. **Memory-safe testing on this Mac (M5, 32 GB).** One model loaded at a time; unload before the next; check free memory and swap before loading; abort on pressure. Never push to a crash. Record hardware in every result.
5. **Work on branch `v0.15.0-work`.** Commits are allowed there (owner approved 2026-09-26). Do not commit to `master`/`main`. Never push or force-push without being asked.
6. **Accuracy over completeness for measurements.** A missing number is fine; a wrong number is not. Report failures and skipped steps faithfully.

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
