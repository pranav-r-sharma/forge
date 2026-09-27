# Hand-off — Forge v0.15.0 (acceptance-test loop, take 4)

**Written:** 2026-09-27, at the owner's request, after a long autonomous session.
**For:** the next agent. Read this whole file first, then `CLAUDE.md` (binding), then the last ~8 entries of `PROGRESS.md` and all of `_devtools/e2e/ITERATION_LOG.md`. If they disagree with this file, trust `PROGRESS.md` + `git log`.

---

## 0. How the owner wants you to work (important — read first)

1. **You are the brain; Cursor is the hands.** You think, plan, review and decide. Every action — file edits, commands, test runs, model runs, commits — is delegated to Cursor through the bridge:
   `bridge wake cursor "<self-contained task>" --model composer-2.5`
   - Use **only `composer-2.5`** (never `composer-2.5-fast`, never another model).
   - `--model` goes **after** the task text (`bridge wake cursor "<task>" --model composer-2.5`); putting it first fails with "unknown option".
   - Read the reply with `bridge read claude`. Tasks over ~10 min: run the Bash call with `run_in_background: true` and redirect output to a log in `$TMPDIR`.
   - If `bridge wake` prints `Authentication required`, Cursor's login expired: stop and ask the owner to run `agent login`. Do not do the work yourself.
   - Reading files / transcripts / diffs yourself to review is fine and expected. **Always review Cursor's diff** (`git show <hash>`) — it has twice made things looser or narrower than asked (see §4).
2. **Harness philosophy (owner directive):**
   - Fixes must be **universal**: work for any model and any task. Never special-case one fixture, one model, or one language (e.g. a check hard-coded to `py_compile` was rejected and made generic).
   - **The model fixes its own mistakes.** No silent auto-repair (owner explicitly rejected auto-adding missing JSON braces).
   - **The harness gives clear, accurate, targeted information**: name the exact tool / file / line / command / error, never a vague "try again". A vague or *false* harness message is a harness bug.
   - Never accept a reply as a final answer when the code can tell something is wrong.
3. **Don't overfit.** The owner rejected spending effort on one fixture's grader. Tests should cover a variety of tasks.
4. **Brief, simple language** in replies. State remaining token budget before any long/background run (CLAUDE.md rule 7).

---

## 1. Test model (changed this session)

- **gpt-oss-20b MXFP4-Q8 (MLX)** only — CLAUDE.md rule 1 was updated. Snapshot:
  `~/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3` (11 GB; also a Q4 variant exists, not used).
- Ornith-1.5-9B is retired as the test model (superseded 2026-09-27).
- Speed ~20–30 tok/s; a run loads in ~2 s. Needs ≥16 GB available before loading (preflight every run: `pgrep -fl mlx_lm.server; ollama ps; memory_pressure`, `vm_stat`). Confirm `mlx_lm.server` is gone after every run.
- gpt-oss speaks **Harmony** format (`<|channel|>analysis ... to=<tool> <|constrain|>json<|message|>{...}`). The harness now handles it (see §3).

Run command template:
```bash
M=~/.cache/huggingface/hub/models--mlx-community--gpt-oss-20b-MXFP4-Q8/snapshots/773a7da77e569019bb0fd17a554b263738d669a3
node _devtools/run-ts.js _devtools/bench/run_task.ts --task <id> --provider mlx --model "$M" \
  --thinking auto --terse true --out _devtools/e2e/results/<id>-gptossq8-cycle<N>.json \
  --timeout-s 1200 --max-iters 80 --keep > _devtools/e2e/results/<id>-gptossq8-cycle<N>.log 2>&1
```
Kept workspaces land in `$TMPDIR/forge-e2e-<id>-XXXX` (path is in the result JSON). Always read the full `.messages.json`, not just the trace.

---

## 2. Test fixtures and status

All under `_devtools/e2e/tasks/`, validated with `python3 _devtools/bench/validate_tasks.py` (all 10 valid).

| Task | What | Status |
|---|---|---|
| t01–t06 | older small tasks | t01 used as smoke test: PASS on gpt-oss |
| t07-build-from-scratch | retired (grader required unittest style task never stated); kept as history |
| **t08-five-file-build** | 5-file expense tracker, py_compile + run end to end | **DONE — 2 consecutive passes (cycles 2,3)** |
| **t09-harder-build** | 7-file library loans (borrow limit 3, 14-day loan, $0.25/day fee capped $10, no double loan), exact CLI forms `add-book --db PATH ...` | **0/4 real cycles — still failing; cycle 5 was cut off (see §5a)** |
| **t10-seeded-bugs** | broken 5-file CSV sales tool with 5 planted bugs (syntax, bad import, crash on blank row, `+` vs `*`, reversed sort); bug list in `README-bugs.md` outside `repo/` | **DONE — 2/2 passes; model finds and fixes all 5** |

Graders (`check.sh`) must only check what `task.md` states (lesson from t07).

**t09 failure pattern:** the model writes all 7 files fine, then `python3 main.py demo` fails on `--db` (it made `--db` a required top-level option). It then rewrites `--db` handling in `inventory/cli.py` and gets lost (duplicate code blocks, IndentationError). Cycle 4 was made much worse by a harness bug (fixed in `7186c10`, not yet validated live).

---

## 3. Harness fixes this session (all committed on `v0.15.0-work`, tests 1370 → 1507 checks, all green)

| Commit | Fix |
|---|---|
| d912e59, 720e092, fc20381 | Abandoned/truncated-action nudges name the exact tool + file; the named unfinished write is **required** before other writes (1 redirect cap; read-only tools allowed; any write to the same path resolves it) |
| 3458397 → 64d4205 | A complete reply with broken JSON gets the real parse error + location (not a false "cut off"); retry cap ends with an explicit failure note (was a silent "success"); brace auto-repair **removed** per owner |
| aa81276 | Foreign-format tool calls are detected, not accepted as final answers; Harmony channels split (analysis = reasoning) |
| 7548178 | Never store `<|...|>` control tokens in history (mlx_lm.server returned HTTP 404 on them); test.ts now counted in npm totals |
| 8c41833 | Accept a native-format tool call **only if complete and exact** (known tool, strict JSON args); retry cap counts **consecutive** failures |
| 805c115 | Accurate message for an empty/incomplete `forge_action` wrapper call |
| 6e5c13b, 2c3119d | **Claimed-command checker**: before accepting a final answer, commands named in it must have been run; per-file check coverage ("ran py_compile on 4 of 5 files; never on main.py") — generic for any check command |
| ba01527 | Harmony calls caught on any channel/constrain tag; **final answer blocked while the last command is still failing** (names cmd, exit code, files edited since; cap 1 then marked unverified); precise arg-type errors ("command must be a string, you sent an array; resend as ...") |
| 375d40c, 115a52b | Per-file check ignores program runs (`python3 main.py demo` is not a per-file check); nested-action-in-args error; **task command forms check**: command forms written in the task must have been run, matched token-by-token in order with placeholder wildcards (PATH, ISBN, YYYY-MM-DD, `<file>`) |
| a26e069 | Unknown tool args flagged with did-you-mean (`line_start` → `start_line`); loop detector **warns once with specifics** (repeated action, still-failing command + error) before stopping |
| 7186c10 | **write_file**: indentation-only edits now applied (whitespace-tolerant match used to say "No changes — already matches" falsely, blocking IndentationError fixes); ambiguous-match errors name line numbers; did-you-mean prefers abbreviations (`cmd` → `command`) |
| d447fb5 | `.vscodeignore` excludes `_devtools/**`, `.agent-bridge/**`, etc. (vsix went 137 MB → 604 KB) |

Other: t08/t09/t10 fixtures (0331596, 468586c, 81def7f, 3421254); result files committed per cycle.

**Known quirks / ideas not done:**
- Hallucination-nudge counter is still whole-run cumulative (cap 2) — left as is on purpose.
- Model habits seen repeatedly on gpt-oss: sends `command` as an array, adds a `timeout` arg, calls non-existent tools (`repo_browser.open_file`, `container.exec`), nests a whole action inside `args`. All now get exact corrective messages and it usually self-corrects next step.
- Indentation fix in 7186c10 keeps the file's indentation on the *first* matched line; a bad indent on that first line is still not fixable via fuzzy match (edge case).

---

## 4. Lessons about Cursor (review its work)

- It made the task-form check loose ("--db moved still matches") contrary to spec — caught in review, fixed in 115a52b.
- It hard-coded the per-file check to `py_compile` — caught, fixed in 2c3119d.
- It speculated a root cause (MLX 404) without evidence — required curl reproduction; the real cause was proven.
- It sometimes reports only partial test runs — ask for the full `npm test` summary line.
Give it exact specs, evidence paths (message numbers), expected messages, and required tests.

---

## 5. Current state

- Branch `v0.15.0-work`, last commit `d447fb5` (plus whatever the hand-off commit adds). Nothing pushed. Tree clean except this hand-off.
- The latest build is **installed in the owner's VS Code** (`local-forge.forge-local-agent@0.14.0`, forced over the old 0.14.0 — version number not bumped; ask the owner before bumping). Build: `npm run package`, install: `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension forge-local-agent-0.14.0.vsix --force`.
- The owner is **testing the build manually** now. Their findings may come first — start by asking for them.
- No model server running.

## 5a. t09 cycle 5 — ran, but was killed (not a valid data point)

- Result files `_devtools/e2e/results/t09-harder-build-gptossq8-cycle5.*` (18:43). It was started by a Cursor task that first appeared to fail on login, then ran once login was restored; it ended with **SIGTERM at 543.7 s, 61 iters** (probably when the owner interrupted a later tool call) — treat as incomplete, re-run it.
- Useful evidence from it anyway:
  1. **Checker false positive (unfixed):** `python3 main.py -h` was treated as a per-file check → "You ran `python3 -h` on 1 of the 7 .py files...". The 375d40c rule ("only flags remain after removing the path") lets `-h` through. Proper universal rule: when the executable is an interpreter (python/python3/node/ruby/bash/sh/…), a file that is the **script being run** (first positional after the interpreter and its options) is never a per-file check target; only files passed as data to a check (e.g. after `-m py_compile`, `--check`) count.
  2. **"No changes — already matches" still appeared** (early, msgs ~28-31) after 7186c10. Verify whether the model's search and replace were byte-identical (then the message is true) or whether 7186c10 missed a path.
  3. The task-command nudge fired again and the model started re-running the spec forms ("We need to run commands exactly as specified") just before the kill — good sign.
  4. No `mlx_lm.server` left running (checked).

## 6. Next steps (in order)

1. Ask the owner for their manual-test findings; triage them under the philosophy in §0.
2. Fix the §5a item 1 checker false positive (universal, tested, one commit) and check §5a item 2.
3. Re-run **t09 cycle 5** (validates 7186c10 live; the earlier cycle 5 was killed). This is t09's 5th cycle — the per-sitting safety valve; after it, report to the owner rather than continuing blindly.
4. Read the full transcript; fix any universal harness gap found (small, tested, one commit each), log in `ITERATION_LOG.md` + `PROGRESS.md`.
5. Ideas to propose (not approved yet): a version bump for dev builds; more task variety (non-Python build, refactor, config/docs change) per the owner's "many kinds of tasks" point.

Standing rules in `CLAUDE.md` still apply in full (branch, no sudo, one model loaded, memory preflight, budget statements, stop repeated runs at first failure, report faithfully).
