# Hand-off — Forge v0.15.0 (MLX-first harness work)

**Written:** 2026-09-27, by the previous agent, at the owner's request to stop and hand off.
**For:** the next agent picking this up.
**Read this whole file before touching anything.** Then read `PROGRESS.md` (the live state file — trust it over this document for "what's next") and `v0.15.0 suggestions.md` (the full plan and reasoning). Then `CLAUDE.md` (standing rules — read this one **first**, actually, since it governs how you're supposed to work here).

---

## 0. Do this before anything else

1. Read `CLAUDE.md` in full. It has the owner's standing rules and the dev cycle. They are not optional.
2. Read `PROGRESS.md`'s **Next** section — that is the literal next action, specific enough to start cold.
3. Run `git log --oneline | head -20` and `git status --short` to confirm the repo matches what this document says. If it doesn't, trust the repo, not this document — something happened after this was written.
4. Run `npm test` and confirm it's green before you change anything. If it isn't, that's the first thing to fix, and say so.
5. Check `git branch --show-current` — you should be on `v0.15.0-work`, not `master`/`main`.

---

## 1. What this project is and why this work exists

**Forge** is a VS Code extension (TypeScript, zero runtime npm dependencies) giving a local, agentic coding assistant — think Cursor/Claude Code, but running entirely against a local Ollama model, no cloud. Current shipped version is 0.14.0 (see `CHANGELOG.md`, `README.md`).

**What the owner asked for, verbatim intent across several messages:**
1. Make Forge MLX-first — first-class support for Apple's MLX framework, not just Ollama, because the owner's primary machine is a Mac (M5 Max, 128 GB — not this dev machine, which is an M5 with 32 GB).
2. All testing/benchmarking uses **Ornith-1.5-9B only**, no other model, varying only runtime (Ollama vs MLX) and quantization (4-bit vs 8-bit).
3. When something is slow, A/B it — harness vs. the raw model directly — to find out whether the harness or the model is the bottleneck.
4. Push memory/context as far as it safely goes on this Mac, without crashing it (memory-gated testing, one model loaded at a time).
5. Go the "whole nine yards": embedding, caching, treeing, everything possible for efficiency; test constantly; iterate.
6. No `sudo` in anything that ships. Ever.
7. A dev cycle designed so a usage-limit cutoff never loses progress (small steps, commit after each, `PROGRESS.md` as the resumable state).
8. Final acceptance test: have the harness itself write a multi-file program in a test repo inside this repo, on the real model, and keep improving until it works well.

**The starting complaint** that kicked this off: "it reads an entire file multiple times, rather than using grep" and general slowness even on strong hardware. That led to a large diagnostic document (`v0.15.0 suggestions.md`) before any code was touched.

---

## 2. The three key documents, and how they relate

| File | What it is | Trust it for |
|---|---|---|
| `v0.15.0 suggestions.md` | The original ~2000-line plan: diagnosis, a phased plan, a cross-spec review against another agent-harness spec the owner pasted, and a full priority-ordered backlog | **Reasoning and the full backlog.** Sections `2.1e` and `0.2c` etc. contain measured findings that were added as the work progressed — it was kept up to date with real numbers, not just the original guesses. Some of its early hypotheses were later corrected in-place (search for "MEASURED" / "supersedes" to find the corrections) |
| `PROGRESS.md` | Live state: Goal, Done (append-only log of what happened, in order), Next (the literal next action), Open questions, Owner decisions | **Current status and what to do next.** This is the resumable checkpoint — if you only read one file, read this one |
| `CLAUDE.md` | Standing rules + the dev cycle (small steps, test, commit, budget checks) | **How to work here.** Also has the Ornith-only rule, the no-sudo rule, the branch rule |

`HANDOFF.md` (this file) is a one-time snapshot for a fresh agent's first orientation — after your first session, go back to trusting `PROGRESS.md` as the live source, not this file (which will go stale).

---

## 3. Standing rules — do not violate these

From `CLAUDE.md`, restated here because they matter most:

1. **Ornith-1.5-9B only, for every test.** MLX 4-bit: `~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/a48173b246ac705be75c05bedf1a0666db522d53`. MLX 8-bit: `models--ornith-ai--Ornith-1.5-9B-MLX-8bit/snapshots/b4b70543d60c81e7c418a001b74cd4352212bd44`. Ollama: `ornith:9b` (confirmed Q4_K_M via `ollama show`). Never substitute another model for testing, even "just to check something quickly."
2. **No `sudo` in anything that ships.** `powermetrics` and anything else needing elevated privileges is out of the product entirely; it may only be used by a human, by hand, for their own investigation. The GPU/memory readout code deliberately uses only `sysctl`, `vm_stat`, `ioreg`, `ps` — all unprivileged.
3. **Work on `v0.15.0-work`.** Never commit to `master`/`main`. Never push or force-push unless explicitly asked (this repo has not been pushed anywhere — it's local-only so far, as far as this agent knows).
4. **Memory-safe testing on this dev Mac (M5, 32 GB).** One model loaded at a time; check free memory/swap before loading; abort on pressure; unload between tests. The M5 Max 128 GB is untested — everything here is relative-improvement evidence, re-confirm absolute numbers there before trusting them.
5. **The dev cycle:** small steps (a few minutes each), run the relevant test after each, update `PROGRESS.md`, commit — one step per commit, never batch several steps into one commit. Never leave the repo in a broken state between commits.
6. **Budget discipline (added after a real miss on 2026-09-27):** state the remaining token count in your reply at three triggers — before launching any background/long-running process, every time a `Monitor` watcher re-arms after its 30-min expiry, and before starting a new major step. This session cannot see the account's actual plan usage limit, only its own remaining context tokens — so this is the best available proxy, and it must be *stated*, not just silently checked, so the owner can catch a miss.
7. **A repeated background operation (a matrix/suite of runs) stops at its first failure** to diagnose it, rather than running the rest of the repetitions against a setup already shown broken. This was also missed once (see §7 below) and is now an explicit rule.
8. **Never delete/overwrite work you haven't read.** Standard rule, worth repeating because this repo has a lot of generated fixture/result files that look disposable but sometimes aren't (the `_devtools/e2e/results/*.json` files are real evidence, committed to git — don't `rm` them without checking whether they're referenced by `PROGRESS.md`'s narrative).

---

## 4. Architecture map — where everything lives

This is a **guide to the code that this work session added or changed**, not a full Forge architecture doc (see the existing `README.md`/`ARCHITECTURE`-equivalent docs for that, if the owner has one — this repo's own docs are `README.md`, `CURSOR_PARITY.md`, `FORGE_CHEAT_SHEET.md`, `ROADMAP.md`, `CHANGELOG.md`).

### 4.1 Provider abstraction (talks to Ollama or MLX interchangeably)

- **`src/llm/provider.ts`** — the `LlmProvider` interface (chat/generate/embed/listModels/ps/health), `ProviderCapabilities` (what a runtime can/can't do — nativeTools, structuredOutput, fim, embeddings, thinkingControl, promptCache, exactTokenUsage, reportsTimings, contextWindow, listsLoadedModels, keepAlive), and three capability presets: `OLLAMA_CAPABILITIES`, `MLX_CAPABILITIES`, `OPENAI_COMPAT_CAPABILITIES`. `parseProviderId()` here (garbled settings degrade to `'ollama'`).
- **`src/ollama/client.ts`** — `OllamaClient implements LlmProvider`. Unchanged behavior, just typed against the new interface. Also gained `finishReason`/`promptEvalDurationMs`/`evalDurationMs` on its metrics (see §4.4).
- **`src/llm/openaiCompatClient.ts`** — `OpenAiCompatClient implements LlmProvider`, talks to `mlx_lm.server`'s OpenAI-compatible HTTP API (or any other OpenAI-compatible server, via `kind: 'openai-compatible'`). Contains `SseParser` (a from-scratch, dependency-free Server-Sent-Events parser — handles split chunks, CRLF, comments/keep-alives, multi-line data). Important facts baked in, verified against the **installed** `mlx-lm` 0.31.3 source (not assumed): MLX always addresses the loaded model as `"default_model"` (any other name makes the server try to *load* a model); no embeddings endpoint; no FIM `suffix` support; usage arrives with `prompt_tokens_details.cached_tokens`; `finish_reason` can be `"length"` (truncated); thinking text arrives as `delta.reasoning`, kept separate from `delta.content`.
- **`src/llm/factory.ts`** — `SwitchableProvider`: the provider Forge actually holds. Reads `forge.provider` on **every call** (no reload needed to switch runtimes), caches clients per (provider, url). **Embeddings and Tab-autocomplete (FIM) fall back to Ollama** when the active provider can't do them (MLX can't) — so `@codebase` search and autocomplete keep working while chat runs on MLX. `providerEndpoint()` gives the active runtime's label+URL for status/error text. `ensureReady`/`mlxState`/`mlxLastError` hooks let it await the MLX server coming up and report "starting" instead of blocking a status-bar poll.
- **`src/llm/mlxServer.ts`** — `MlxServerManager`: spawns/stops/restarts `mlx_lm.server`. Facts worth knowing: offline (`HF_HUB_OFFLINE=1`, never downloads), loopback-only (`127.0.0.1`), refuses `--trust-remote-code`/`--host`/`--port`/`--model` in user-supplied extra args, checks free memory *before* loading (rejects if `< 1.15× model size + 1.5 GB` available), **adopts** an already-healthy server on the target port instead of fighting for it (and never kills an adopted server it doesn't own), SIGTERM→SIGKILL escalation, crash detection distinguishes an intentional kill from a real crash. `resolveModelPath()` resolves a local folder or an already-cached HF repo id (never downloads); `resolvePython()` falls back to `~/.forge/mlx-venv` then `python3`; `parseLocalServerUrl()` decides whether a configured base URL is this machine (loopback) or remote. `makeEnsureMlx()` is the decision function wired into `SwitchableProvider`.
- **Settings** (`package.json` + `src/util/config.ts`): `forge.provider` (`ollama`|`mlx`|`openai-compatible`, default `ollama`), `forge.mlx.baseUrl`, `forge.mlx.model`, `forge.mlx.pythonPath`, `forge.mlx.autoStart`, `forge.mlx.promptCacheGB`, `forge.mlx.extraArgs`, `forge.mlx.contextTokens` (the effective context window when the runtime fixes it server-side, unlike Ollama's per-request `num_ctx`), `forge.openaiCompat.baseUrl`.
- **Tests:** `test_v15_provider.ts` (Ollama-as-LlmProvider, real HTTP against a fake server), `test_v15_openai_client.ts` (SSE parser + MLX client, real HTTP against a fake `mlx_lm.server`-shaped server), `test_v15_factory.ts` (SwitchableProvider switching/fallback/ensureReady), `test_v15_mlxserver.ts` (lifecycle manager against a fake child process). `provider_contract.ts` is a **reusable** assertion set both real clients pass (start here if you add a third provider).

### 4.2 Accurate hardware readout

- **`src/util/hwSampler.ts`** — the new module. `readMemorySample()` gives Activity-Monitor-accurate memory (used = anonymous−purgeable+wired+compressed; page size read from `vm_stat`'s own header, never assumed 4096 — it's 16384 on Apple silicon). `readGpuSamples()`/`parseIoregAccelerator()` parse `ioreg -c IOAccelerator` for GPU utilization/memory (no sudo). `HwSampler` is the continuous-sampling class: one timer, GPU value smoothed over ~4s (raw instant swings 0↔100 within a second — display the average, not the instant), per-turn peak via `resetPeak()`. `hwFieldsForUi()` maps a snapshot to the exact webview protocol shape.
- **Why this exists:** the *old* `src/util/hwMetrics.ts` (`getRamStatus()`) used `os.totalmem() - os.freemem()`, which on macOS wildly overstates "used" (measured: it said 24.3 GB used when the real figure was 11.2 GB) because it treats all never-touched pages as the only "free" memory, ignoring reclaimable file cache.
- **Wired into `src/chat/chatViewProvider.ts`**: one shared `HwSampler`, pushes `hwStatus` to the webview itself (2s idle / 1s while busy) instead of only refreshing on click (a second, separate cause of stale numbers that existed before this work).
- **`media/webview.js`**: footer now shows `Mem used/total · free · pressure · swap · GPU avg% · GB`, with `n/a` when a source fails, and a tooltip defining every number.
- **⚠️ NOT visually verified.** This was built and unit-tested, but nobody has looked at the actual VS Code footer to confirm it renders sensibly — there's no way to run the VS Code GUI from this dev environment. **First thing to ask the owner, or do yourself if you have GUI access: open Forge in VS Code, glance at the footer, compare against Activity Monitor.**
- **Tests:** `test_v15_hwsampler.ts` — includes a real captured `vm_stat`/`ioreg` fixture and a *live* check (runs on whatever machine executes the test).

### 4.3 Append-only prompt (the single highest-measured-value change)

- **`src/agent/contextManager.ts`** — new functions alongside the old ones (old ones kept, used only when `forge.context.appendOnly = false`): `updatePromptView()` is the new default path. Design: the prompt sent to the model is **never rewritten** except at two deliberate, batched events — masking stale file reads (at a high-water mark, default 75% of the context window) and, if still too big, summarizing old turns (down to a low-water mark, default 45%). Escalates through several "how aggressively to clean" levels so a cleanup always makes real progress instead of firing every step. The original first user message is always pinned verbatim through compaction. `capOversizedStable()` caps any single oversized message **without depending on its position** (the old `hardCapOversizedMessages()` exempted the last two messages, which meant a message's truncation state could flip between steps — breaking the very cache-stability this exists to protect). `updateCharsPerToken()` learns the real chars-per-token ratio from the runtime's own reported token counts (the old fixed guess of 4 was measured wrong — Ornith on code is closer to 2.5–3).
- **Why this matters — the measured finding that drove the rest of the session:** using Forge's own `OpenAiCompatClient` against the real `mlx_lm.server` with Ornith, an **exact-prefix repeat** of a ~5k-token prompt was served **100% from the server's prompt cache** (179ms vs 6600ms cold — 37× faster). An **append-only agent-loop shape** (each step = previous messages + reply + one new message) got **93–94% cache hits**, ~9× faster steps. But **replacing one old message with a stub** (exactly what Forge's old per-step pruning did) dropped the hit rate to **~1%** — a full re-read every step. This is why append-only is now the default and is treated as the top-priority fix in the whole plan (`v0.15.0 suggestions.md` §2.1e has the full data table).
- **Settings:** `forge.context.appendOnly` (default `true`), `forge.context.highWaterPct` (75), `forge.context.lowWaterPct` (45).
- **Tests:** `test_v15_promptview.ts` — includes a **prefix-stability property test** (40 steps under the high-water mark must produce byte-identical prompt extensions with zero events) and a **through-the-real-agent-loop** test comparing append-only vs legacy on the same 24–30-step synthetic conversation (measured: 5 rewrites vs 25).

### 4.4 Trace log and read-coverage tracking

- **`src/agent/traceLog.ts`** — `TraceWriter`: one JSON line per agent iteration to `.forge/traces/<sessionId>.jsonl`. Records sizes/timings/tokens/tool name/hashed args — **never file contents or command output** (safe to keep next to a repo). Best-effort: a broken sink can never break a turn (every failure swallowed). `argsHash()` is a short hash of tool args for grouping without storing them. `hwForTrace()` compresses a hardware snapshot into the trace record.
- **`src/agent/readCoverage.ts`** — pure range-tracking (`ReadCoverage`): flags a `read_file` call as redundant when every requested line is already covered by an earlier read this turn, invalidated by a write to that file or any shell command. This is the direct measurement of the original complaint ("reads the whole file multiple times").
- **`src/agent/environment.ts`** — `detectEnvironment()`/`renderEnvironment()`: presence-only PATH scan (python3/python/node/npm/git/rg/pytest/…) plus project-kind + likely test/build command detection from manifests (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`). **Deterministic and cheap** — lives in the *cached* part of the system prompt (never invalidates the append-only prefix). Added because the model guessed `python` on a machine with only `python3`, wasting real steps.
- **`_devtools/bench/trace_report.py`** — stdlib-only summarizer: redundant-read %, tokens evaluated vs. estimated-sent (cache-saved %), **server-reported cache-hit %** when the runtime provides it (MLX does, Ollama doesn't), model-vs-tool time split, hardware low-points. `_devtools/bench/test_trace_report.py` tests it with a synthetic trace.
- **Settings:** `forge.trace.enabled` (default `true`).

### 4.5 Edit-engine fixes (the most consequential bug-hunting of the session)

- **`src/tools/fileTools.ts`**:
  - **`write_file` gained `edits: [{search,replace}, …]`** (several edits to one file, one call, applied in order, all-or-nothing) **and `all: true`** on a single search/replace (replace every occurrence — e.g. a rename). Motivated by a live measurement: renaming one symbol across 5 files took **16 single-edit calls** and blew the 30-step budget. The single-edit logic was extracted into `applySearchReplace()`/`applyReplaceAll()` so both the old single-edit path and the new `edits[]` path share it.
  - **`reindentReplacement()` fix #1 — dedented-definition guard.** When a replacement's first line *starts a new definition* (`def`/`class`/`function`/`fn`/decorator, see `STARTS_DEFINITION_RE`) at a *shallower* indent than the line it's replacing, the old code force-indented it onto the anchor's depth — which meant a deliberately top-level `def slugify(...)` got nested **inside** the function it was replacing. Found live, reproduced, fixed: such a block is now left exactly as authored.
  - **`detectDuplicateDefinitions()`** — new advisory: warns when an edit leaves a function defined inside itself, or twice at the top level (the failure mode the dedented-definition bug produced before it was fixed at the root — kept as a second line of defense for cases the first fix doesn't catch).
  - **`echoEditedRegion()`** — every successful edit's result now includes the changed lines, numbered like `read_file`, so the model doesn't need a separate verification read. Measured: this alone cut a chain of 7 read-then-fix-then-read steps down significantly.
  - **`reindentReplacement()` fix #2 — THE CRITICAL BUG, found on 2026-09-27, after the above were already believed to have fixed the edit engine.** When a model's `search` text omits a line's *leading whitespace* (extremely common — the model isn't changing the indent, just the code), the file's real indentation stays physically in place (untouched, since it wasn't part of `search`), but the old reindent code **added the anchor's indent again on top of it** — `"    return x"` → `search:"return x"`, `replace:"return y"` → **`"        return y"`** (8 spaces), an `IndentationError` in Python. A second instance of the same bug hit a *later* line in a multi-line search whose own indentation was already correct/absolute. **Fixed** with a new `anchorIndentAlreadyPresent` flag: the anchor line gets no prefix added when its indent is already physically there, and later lines' depth is computed **without** re-adding `baseDepth` in that case. **This bug had almost certainly been corrupting edits since well before this session** (it's in the pre-existing 0.12.0/0.14.0 indentation code) — it just took a real multi-file task on a real weaker model to surface it, because a 9B model omits leading whitespace in `search` far more often than whatever this logic was originally tested against.
  - **This bug is exactly why `t04-rename-symbol` and `t06-multi-file-feature` were slow/failing** in earlier suite runs (models were burning steps on `cat -A`, `sed`, ad-hoc `python3 -c` scripts trying to debug indentation errors Forge itself had introduced) — **not** thinking mode, not terse style, not the environment facts. Confirmed by a targeted rerun after the fix: `t04` went from 26–30 iterations (with tool failures) to a clean **9 iterations, 0 failures**.
  - **`src/tools/commandTool.ts`** — `resolveCommandCwd()`: `run_command`'s `cwd` argument used to be resolved and handed straight to `spawn`, so a nonexistent folder produced an opaque `spawn /bin/sh ENOENT`. Found live: the model passed the **workspace's own name** as `cwd` (reading `t05-large-file` in the environment text like a folder name) and got that error 5 times in a row. Now: checks the folder exists first; if the requested name equals the workspace's own name, it self-corrects and explains; otherwise it lists the real folders in the workspace root.
  - **Tests:** `test_v15_edits.ts` (53+ checks, including an exact **replay** of the live failing edit sequence from the `t03` run, and dedicated regression tests for both double-indent scenarios across tabs/spaces/deep nesting/multi-line/the new `edits[]` path), `test_v15_command.ts` (19 checks including real `run_command` executions, not just the pure function).

### 4.6 Adaptive thinking, truncation fix, terse style

- **`src/agent/agentLoop.ts`**:
  - **Truncation fix (correctness bug, any runtime):** `mlx_lm.server` defaults to 512 output tokens; Forge never checked the finish reason, so a reply cut off mid-thought was silently accepted as the **final answer**. Fixed: `forge.maxOutputTokens` (default 4096) is sent on every call; `OllamaCallMetrics.finishReason` is captured from both runtimes (`done_reason` for Ollama, `finish_reason` for the OpenAI-compatible client); a `length`-truncated reply with no complete tool call gets a bounded (≤3) "you were cut off, continue" nudge instead of being accepted as done.
  - **`thinkingForStep()` / `forge.thinking` (`auto`|`default`|`off`|`on`, default `auto`).** Measured: thinking OFF is 2–4× faster per step but can outright fail a task requiring real reasoning (`t03`: failed with thinking off, solved with thinking on, 335s/7.9k tokens). `'auto'` starts fast (off) and switches on after `THINKING_ESCALATION_FAILURES` (2) consecutive failed `run_command` results, reverting to off after a success. This is a genuine adaptive-effort mechanism, not a fixed setting.
  - **`forge.terseSteps` (default `true`)** — asks the model for ≤1-sentence reasoning before a tool call and short final answers. Measured on `t01`: environment-facts alone 69s→33s (wrong `python` guess defused); terse alone 69s→28s; both together 69s→27s (2.9× faster, 3.3× fewer output tokens).
  - **Tests:** `test_v15_truncation.ts`, `test_v15_adaptive.ts`.

### 4.7 End-to-end evaluation infrastructure (didn't exist before this session)

- **`_devtools/e2e/tasks/`** — six task fixtures, each with `repo/` (the starting state), `task.md` (the prompt), `check.sh` (pass/fail), `meta.json` (protected files, expected files), and a `reference/` solution:
  - `t01-fix-bug` — a one-line bug in a small cart module; unittest-based check.
  - `t02-locate` — read-only: answer which function/file/behavior; checked via `$FORGE_FINAL_FILE`.
  - `t03-add-function` — add `slugify()` + 3+ tests; hidden `acceptance.py` checks correctness beyond what the model's own tests might cover.
  - `t04-rename-symbol` — rename a function across 5 files; grep-based check (old name gone, new name used ≥5×) plus tests.
  - `t05-large-file` — a 1,129-line generated module with one bug buried in the middle (tests read discipline / search vs. whole-file-read).
  - `t06-multi-file-feature` — add a `delete` command across storage + CLI + tests; hidden `acceptance.py` runs the actual CLI via subprocess.
- **`_devtools/bench/validate_tasks.py`** (+ `test_validate_tasks.py`, wired into `npm test`) — proves every task's `check.sh` **fails** on the starting repo and **passes** with the reference solution applied, and that the reference never touches a protected file. This caught two of my own mistakes (an unfair check.sh threshold, and a miscounted one) — **trust the validator over your own check.sh logic**.
- **`_devtools/bench/run_task.ts`** — the headless runner: copies a task's `repo/` to a temp workspace, starts an MLX server (or uses Ollama), runs the **real** `runAgentTurn()` with the **real** tools (via the existing `vscode` fs-backed stub — no VS Code GUI needed), enforces a wall-clock + iteration budget, runs `check.sh`, writes a JSON result + saves the full `messages.json` transcript + a trace `.jsonl`. CLI flags: `--task --provider --model --thinking --terse --ctx --max-iters --timeout-s --append-only --port --keep --no-env`.
- **`_devtools/bench/run_matrix.py`** — runs `run_task.ts` over named configs × repetitions, prints medians. **`_devtools/bench/run_suite.sh`** wraps this over all 6 tasks for one model/provider.
- **All raw results are committed** under `_devtools/e2e/results/<label>-<task>-<config>-r<N>.{json,messages.json,trace.jsonl}` — these are real evidence, not disposable. Check `PROGRESS.md`'s "Done" log for what each `suiteN`/`p15` label means before deleting anything.

### 4.8 MLX venv (not committed, must be recreated if missing)

`_devtools/mlx-venv/` is gitignored (per `.gitignore`) but was created with:
```
python3 -m venv _devtools/mlx-venv
./_devtools/mlx-venv/bin/python -m pip install "mlx-lm==0.31.3"
```
Confirmed working versions: `mlx` 0.32.2, `mlx-lm` 0.31.3 (supports `qwen3_5`, i.e. Ornith's architecture — verify this again if you upgrade `mlx-lm`, since Ornith is a newer/less-common architecture). `_devtools/mlx-requirements.txt` has the full pinned freeze. **If the venv is missing** (fresh checkout), recreate it with the exact command above before running anything MLX-related — ask the owner first, per the no-silent-installs rule, even though it was already approved once this session (approval doesn't automatically carry to a new agent/session without re-confirming, per the owner's earlier stated expectations about consent).

---

## 5. Measured results — what to actually believe

**Take these as directional evidence from one dev machine (M5, 32 GB), not final numbers.** Re-confirm on the M5 Max 128 GB before trusting absolute values there.

### 5.1 Runtime/quantization raw speed (Ornith, this Mac)

| | Decode | Prefill (short prompt) | Notes |
|---|---|---|---|
| Ollama `ornith:9b` Q4_K_M | ~14 tok/s | ~317-455 tok/s at 2-2.5k tokens, drops with length (~116 tok/s at 52k) | |
| MLX 4-bit | ~18 tok/s | ~455 tok/s at 2.5k, **~445 at 16k (doesn't drop with length in this range)** | |
| MLX 8-bit | ~11 tok/s | ~386 tok/s | slower than 4-bit, as expected |

### 5.2 Prompt cache (the big one — see §4.3)

| Shape | Cache hit | Speedup |
|---|---|---|
| Exact repeat | 100% | 37× |
| Append-only agent loop | 93-94% | ~9× per step |
| Old per-step pruning (rewriting one old message) | ~1% | none — full re-read |

### 5.3 Full 6-task suite, before vs. after this session's fixes (Ornith MLX-4bit, `thinking=auto, terse=true`, 2 reps/config)

| Task | Before (pass, wall) | After (pass, wall) |
|---|---|---|
| t01-fix-bug | 2/2, 69s | 2/2, 33s |
| t02-locate | 2/2, 13s | 2/2, 14s (no change — tiny read-only task) |
| t03-add-function | 1/2, 196s | 2/2, 250s (adaptive thinking spent more time but solved it) |
| t04-rename-symbol | 0/2 (30-step cap) | **2/2, 45.5s, 9 iterations, 0 failures** (after the double-indent fix — see below) |
| t05-large-file | 2/2, 37s | 2/2, 31s |
| t06-multi-file-feature | 0/2 (30-step cap) | flaky (0-2/2 across reruns) — see caveat below |

**Total: 7/12 → 12/12 pass** in the main suite run, **but** a later confirmation rerun of just t04/t06 (`suite3`) showed t04 solidly fixed (2/2, 9 iterations both times) while **t06 regressed to 0/2** — investigated and found to be an *unrelated*, model-behavior issue: the model's own unit tests passed and it declared done **without running the task's hidden `acceptance.py`** (which exercises the CLI end-to-end). This is eval-task/model flakiness (matches earlier t03 behavior — temperature 0 is not perfectly deterministic across long multi-step runs), not a regression from the double-indent fix. **Don't cite "12/12" as a stable, reproducible number — it's evidence of large improvement, not a certified pass rate.** More repetitions (5+) would be needed to quote a real pass rate for t03/t06.

### 5.4 Runtime comparison (P0-15) — INCOMPLETE, see §7

Ollama leg only, 3 reps, `thinking=auto, terse=true`, post-double-indent-fix:
- t01: 3/3 pass, 18.2-26.9s, 6 iterations every time.
- **t04: 0/3 pass, 55.9-63.5s, 9 iterations every time** — consistent, not noise. The model stops after 9 steps with the rename left incomplete (leftover old symbol name in the test file). This looks like a genuine Ollama-vs-MLX capability gap on this task (same model weights family, different quantization — GGUF Q4_K_M vs MLX 4-bit affine — so it's not purely "the runtime," could be the quantization), **but this has not been root-caused**. Next agent: look at the actual transcript (`_devtools/e2e/results/p15-t04-rename-symbol-ollama-r*.messages.json`) before assuming it's a runtime issue rather than, e.g., a different chat-template rendering on Ollama.
- t05: 3/3 pass, 28.7-36.6s, 7 iterations.
- **MLX-4bit and MLX-8bit legs: no data at all** — blocked by a port collision from an orphaned server process (see §7), and the owner asked to stop before it could be fixed and rerun.

---

## 6. Test suite status

`npm test` runs `_devtools/run-tests.js`, which runs every `_devtools/runtime_test/test_*.ts` (TypeScript, using a hand-written fs-backed `vscode` stub in `_devtools/stubs/vscode/index.js` — **this stub did not exist before this session**; the original sandbox's `vscode` shim was type-only and didn't let tests actually run) plus every `_devtools/bench/test_*.py` (stdlib-only Python).

**As of the last commit (`fd3bd89`): 37/37 test files pass, 1,336 checks.** This grew from a baseline of 23 files / 782 checks at the very start of this session (before any MLX work) — the growth is almost entirely new `test_v15_*.ts` files (see §4 above for what each covers) plus 2 real type errors fixed in `chatSession.ts` that the old loose sandbox type-shim had been hiding (confirmed `tsc -p ./` didn't build cleanly on a real machine before this fix).

**Run this before and after any change:**
```
npm run typecheck   # tsc --noEmit -p ./  — must be 0 errors
npm test             # must be N/N files, 0 failed
npm run compile      # tsc -p ./ — must succeed
```

The test runner (`_devtools/run-tests.js`) was hardened mid-session: it now requires a file to print its own "All ... passed." completion line, not just exit 0 — a test whose event loop empties early (an unref'd timer) used to silently "pass" with its checks never having run. If you add a new async test file, make sure it truly awaits to completion.

---

## 7. Open threads — exactly where to resume

These are also in `PROGRESS.md`'s Next/Open-questions sections; repeated here with more narrative context.

### 7.1 Immediate: finish the P0-15 runtime comparison

**What's blocking it:** an orphaned `mlx_lm.server` process was left running on port 8126 from an earlier *aborted* comparison run — the cleanup command (`pkill -f run_comparison.sh` + `pkill -f run_task.ts`) matched the wrapper script and the Node process, but not the Python grandchild it had spawned, which kept the port bound. This made every subsequent MLX attempt fail with `OSError: [Errno 48] Address already in use` instead of adopting the (actually still-healthy) orphan — `MlxServerManager.ensure()`'s adopt-check (`isHealthy()`) apparently didn't see it as healthy in time, which itself might be worth a closer look (a flaky health check under load could bite a real user too, not just a benchmark script).

**To resume:**
1. `pgrep -fl mlx_lm.server` — confirm nothing is orphaned (should be clean; it was killed before this handoff was written, but a new agent starting cold should always check).
2. Fix the benchmark wrapper script (it wasn't committed — it lived at `/tmp/run_comparison.sh`, which won't survive a session; rewrite it, this time using a **different port per repetition or an explicit `pkill -f mlx_lm.server` between every single run**, not just at cleanup time).
3. Consider (small, real robustness improvement, worth a proper fix in `MlxServerManager` rather than just working around it in the benchmark script): retry the health check once with a short delay before deciding to spawn a new server on an occupied port, in case the existing one is just slow to answer under load.
4. Re-run: Ollama vs MLX-4bit vs MLX-8bit on t01/t04/t05 (skip t02 — no measured gain; skip t03/t06 — known flaky, not worth 2 reps, would need 5+ to mean anything).
5. **Follow the budget/failure-stop rules from `CLAUDE.md` §standing-rule-6/7 while doing this** — that's exactly the process that broke down last time.
6. Decide the harness default runtime/quantization using the decision rules already written in `v0.15.0 suggestions.md` §0.2c (C1: compare O-Q4 vs M-4 isolating runtime; C2: M-4 vs M-8 isolating bit-width; thresholds set from measured noise, not assumed).

### 7.2 Investigate the Ollama t04 failure properly

Don't assume it's "Ollama is worse." Read `_devtools/e2e/results/p15-t04-rename-symbol-ollama-r*.messages.json` and find out *why* it stops at exactly 9 iterations every time with the rename incomplete — compare against the MLX transcript for the same task (`_devtools/e2e/results/suite3-t04-rename-symbol-new-r*.messages.json`, from the confirmation rerun) to see where they diverge.

### 7.3 t06 flakiness

Both known failures are the model declaring victory after its *own* tests pass, without ever exercising the hidden `acceptance.py`. This might be fixable with a prompt-level nudge ("a task's own tests may not be the only bar — consider whether an integration/CLI-level check would catch more") but be careful not to leak the existence of a *specific* hidden check into the prompt in a way that would make the eval meaningless for future tasks. Consider whether this is even a Forge problem to solve versus an inherent property of "the model doesn't know what it doesn't know to test."

### 7.4 The rest of the plan (`v0.15.0 suggestions.md`)

Phase 0 is essentially done. The **0.15.0 release** items not yet started (search the plan doc for these headings): ripgrep-class `search_code` with context lines (§3.1), read outline/symbol/multi-range modes (§3.2), the KV/prompt-cache **disk** persistence tier (§2.1c/d — note §2.1e already answered "is a custom cache worker needed for the in-session case" with **no**, the stock server's in-memory cache is enough; disk persistence for cross-session resume is still open), parallel/native tool calling (§6.1/6.2), the LSP-backed navigation tools (§3.4). **Before building any of these, check the trace's redundant-read counter on real runs** — a chunk of the original "re-reads the whole file" complaint may already be substantially mitigated by the append-only prompt + edit-echo + environment-facts work, and building more read/search infrastructure without re-measuring first risks solving an already-shrunk problem instead of the current biggest one.

### 7.5 Visual/UI verification still outstanding

The hardware-readout footer (§4.2) has never been looked at by human eyes. Same goes for anything else UI-facing this session touched (none, really — this session was backend/agent-loop/tools only). If the owner or a future agent has VS Code GUI access, that's a quick, valuable check.

---

## 8. Things that surprised me — worth knowing before you re-derive them

1. **The biggest wins came from bug-hunting on the real model, not from the original plan's speculative "read less" ideas.** The double-indent bug, the silent-truncation bug, and the opaque-cwd-error bug were all found by *actually running the harness end-to-end on Ornith* and reading the transcripts, not by reading the code and guessing. **Do this before writing more infrastructure.**
2. **Temperature 0 on a real model is not fully deterministic across long multi-step runs.** `t03` old-config: 1 pass, 1 fail, identical settings. Don't trust n=1, and be skeptical of n=2 on anything longer than ~15 steps — budget for more repetitions on tasks that matter for a real decision.
3. **The step/iteration cap interacts badly with genuine task difficulty.** Several "fails" in early runs were really "ran out of steps," not "did the wrong thing" — always check `agentError`/`timedOut` in the result JSON before concluding a task failed on merit.
4. **A model omitting a line's leading whitespace in a `search` string is the *normal* case, not an edge case**, for a 9B model. Any future edit-tool work should assume this as the default behavior to design for, not a corner case to patch after the fact.
5. **The MLX server's prompt cache only reuses an *exact* prefix match** (Ornith's hybrid-attention layers aren't "trimmable"), which is *why* append-only-with-batched-cleanup is the right design, not a KV-cache research project — this was genuinely worth measuring rather than assuming.
6. **`ollama show <model>` is worth running before believing a model's quantization** — don't assume from the tag name.

---

## 9. Quick reference — commands you'll actually run

```bash
# From the repo root:
npm run typecheck && npm test && npm run compile   # before/after every change

# One test file directly:
node _devtools/run-ts.js _devtools/runtime_test/test_v15_edits.ts

# Validate the eval tasks are still sound:
python3 _devtools/bench/validate_tasks.py

# A single headless end-to-end run on Ornith-MLX:
S4=$(ls -d ~/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-9B-MLX-4bit/snapshots/*)
node _devtools/run-ts.js _devtools/bench/run_task.ts \
  --task t01-fix-bug --provider mlx --model "$S4" \
  --thinking auto --terse true --out /tmp/out.json --timeout-s 300 --max-iters 30

# Summarize a trace:
python3 _devtools/bench/trace_report.py _devtools/e2e/results/<name>.trace.jsonl

# Check nothing is orphaned before starting:
pgrep -fl mlx_lm.server ; ollama ps ; memory_pressure | grep "free percentage"
```

---

## 10. Final state snapshot (for cross-checking against a fresh `git log`)

- **Branch:** `v0.15.0-work`
- **Last commit at hand-off time:** `fd3bd89` — "Record partial P0-15 comparison (Ollama leg only, 3/3 t01, 0/3 t04, 3/3 t05); MLX leg blocked and not retried"
- **Tests:** 37/37 files, 1,336 checks, 0 failures
- **No MLX server process running; no Ollama model loaded** (both confirmed stopped before this document was written)
- **Nothing pushed anywhere** — this is entirely local to this machine so far, as far as this agent is aware; confirm with the owner before assuming a remote exists

Good luck. Read the transcripts before you trust a summary — including this one.
