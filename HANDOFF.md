# Hand-off — Forge v0.15.0 (final acceptance test)

**Written:** 2026-09-27, by the previous agent, at the owner's request to hand this specific task to a fresh agent.
**For:** the next agent picking this up.
**Read this whole file before touching anything.** Then `CLAUDE.md` (standing rules — binding, read this one **first**, actually) and `PROGRESS.md` (live state — trust it over this document for "what's next" if they disagree).

---

## 0. Do this before anything else

1. Read `CLAUDE.md` in full. Standing rules and the dev cycle. Not optional.
2. Read `PROGRESS.md` in full, especially the last few "Done" entries and "Next".
3. `git log --oneline | head -10`, `git status --short`, `git branch --show-current` — confirm you're on `v0.15.0-work`, the tree is clean, and the last commit is `3a56050` ("Make MLX the default provider..."). If it doesn't match, trust the repo over this document.
4. `npm run typecheck && npm test && npm run compile` — must be clean (37/37 files, 1,338 checks) before you change anything.
5. `pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"` — confirm nothing is orphaned and memory is healthy before loading anything.

---

## 1. Where things stand (short version — PROGRESS.md has the full detail)

Phase 0 of the v0.15.0 plan is **complete**: MLX support built (provider abstraction, server lifecycle, prompt caching), a hardware readout that's actually accurate, per-iteration trace logging, several real bug fixes found by running the harness live (a double-indentation bug in the edit engine, a silent-truncation bug, a confusing cwd error), a 6-task eval harness (`_devtools/e2e/tasks/`), and a full runtime/quantization comparison (Ollama-Q4 vs MLX-4bit vs MLX-8bit).

**The owner has now decided: MLX-4bit is the live default.** `forge.provider`'s packaged default in `package.json` is `"mlx"` (was `"ollama"`), and the owner's real VS Code user settings (`~/Library/Application Support/Code/User/settings.json`, outside this repo) now set `forge.provider: "mlx"`, `forge.mlx.model` (the 4-bit snapshot), and `forge.mlx.pythonPath` (pointing at this repo's `_devtools/mlx-venv` — no new install was made). This was a deliberate choice made *despite* MLX being 1.5-2x slower wall-clock than Ollama on tasks both pass (see PROGRESS.md's P0-15 entries for the full data and reasoning) — the owner weighed MLX's lighter memory footprint and its correctness edge on one task higher than Ollama's raw speed, and explicitly said "that's been the goal anyway."

**⚠️ Known gap, not yet verified:** nobody has actually opened Forge in a real VS Code window since this default changed. It's been proven through the headless bench runner (`_devtools/bench/run_task.ts`) only. If anything about live extension activation (not headless) behaves differently, that's new information — don't assume it "just works" because the headless runner does.

---

## 2. Your task: the final acceptance test (CLAUDE.md standing rule 8)

This is a **standing rule from the owner**, verbatim: *"create a test repo inside this repo (`_devtools/e2e/`), have the harness (on Ornith) write a multi-file program in it, monitor the run, and keep improving the harness until it works well."*

**This has never been done.** Every existing eval task (`t01`-`t06` in `_devtools/e2e/tasks/`) starts from an existing small repo and asks the harness to fix or extend it. None of them ask the harness to build something **from nothing**. That's a materially different and harder test — no scaffolding, no existing style to follow, no hints about file layout.

**What the owner asked for just now, specifically (2026-09-27):**
1. Run this end-to-end test.
2. **Monitor and observe it closely** — don't just wait for a final pass/fail.
3. **Log**: where it lags (unusually slow steps), where there's a performance drop (compare against what P0-15's numbers would predict), and where it **outright fails** (wrong output, crash, stuck loop, budget exhausted).
4. Bring this log back — the owner will decide the fixes/next steps. **Do not silently implement fixes.** Report findings, propose options if a fix seems obviously right, and let the owner choose — this matches how the last two open items (t04/t06 root causes) were handled: root-cause and report, don't just patch and move on. See PROGRESS.md's `option-catalog-and-approval`-style precedent in the Owner decisions log.

**How to set this up (no existing task fixture matches — you'll build one):**
- Pick or design a genuinely multi-file program small enough for a 9B model in a reasonable step budget, but real enough to matter — e.g. a small CLI tool with 3-4 modules (a data model, a storage/persistence layer, a CLI entry point, tests), similar in *shape* to `t06-multi-file-feature`'s `notes` app but built from an **empty** starting repo, not an existing one. You decide the exact spec; keep it concrete and unambiguous (the existing `_devtools/e2e/tasks/*/task.md` files are good models for how specific to be).
- This is **not** another benchmark matrix run (the owner explicitly asked to pause more of those) — it's a small number of **closely observed** runs, not 3 reps for a median. One or two full runs, watched carefully, is the point.
- Use `_devtools/bench/run_task.ts` as the runner (it already has `--keep` to preserve the workspace afterward for inspection, and writes a full trace + message transcript) — or run Forge live in VS Code if you have GUI access, which would also finally close the "MLX default not yet verified live" gap from §1. Either is valuable; live-in-VS-Code is more valuable if you can do it.
- Provider: MLX-4bit (now the default) — `~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/*`. Ornith only, per Directive 4 — no exceptions.
- Watch the trace (`_devtools/bench/trace_report.py <trace.jsonl>`) for: redundant reads, cache-hit%, model-vs-tool time split, hardware low-points, and read the transcript (`.messages.json`) yourself for anything a summary metric wouldn't show (a step that "succeeded" but produced something subtly wrong, a moment where the model seemed confused, an edit that almost broke like the double-indent bug did).

---

## 3. Standing rules that apply here — do not violate

From `CLAUDE.md` (read the full file — this is the short list of what bit people before):
1. **Ornith-1.5-9B only**, MLX-4bit for this task (it's now the default; no reason to use anything else).
2. **No `sudo`** in anything that ships.
3. **One model loaded at a time.** Check `ollama ps` / `pgrep -fl mlx_lm.server` before loading; unload/stop between different runtimes if you end up needing both.
4. **Work on `v0.15.0-work`.** Never commit to `master`/`main`. Never push without being asked.
5. **Dev cycle:** small steps, test/verify after each, update `PROGRESS.md`, commit — one step per commit. This applies to any *code* changes; the acceptance-test run itself is an observation task, not a series of code commits, but if you build a new task fixture under `_devtools/e2e/`, commit that as its own step, separate from any harness fixes.
6. **Budget discipline:** state your remaining token count before any background/long-running run, at every `Monitor` re-arm, and before starting a major step. This session cannot see the account's plan usage limit, only its own remaining tokens — state it anyway, every time, out loud in your reply.
7. **A repeated operation stops at its first failure** to diagnose it — this specific task is naturally one-at-a-time and closely observed, so this should be easy to honor, but if you do end up running it more than once, don't blindly repeat past an infra-level failure (a crashed server, a port conflict) without understanding it first.
8. **Never delete/overwrite work you haven't read.** `_devtools/e2e/results/*` has real committed evidence from P0-15 — don't touch it. Whatever you build for this task should live somewhere new (e.g. `_devtools/e2e/tasks/t07-...` if you want it to become a permanent fixture, or a clearly-scratch location if it's meant to be a one-off).

---

## 4. Quick reference

```bash
# Confirm state
npm run typecheck && npm test && npm run compile
git log --oneline -10 && git status --short && git branch --show-current
pgrep -fl mlx_lm.server; ollama ps; memory_pressure | grep "free percentage"

# The MLX-4bit snapshot (Ornith only)
S4=$(ls -d ~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/*)

# A single closely-observed headless run, workspace kept for inspection afterward
node _devtools/run-ts.js _devtools/bench/run_task.ts \
  --task <your-new-task-dir-name> --provider mlx --model "$S4" \
  --thinking auto --terse true --out /tmp/acceptance-out.json --timeout-s 600 --max-iters 40 --keep

# Summarize the trace
python3 _devtools/bench/trace_report.py _devtools/e2e/results/<name>.trace.jsonl
```

Good luck. Read the transcript yourself before trusting a summary metric — that's how the double-indent bug, the truncation bug, and both t04/t06 root causes were actually found this session.
