# Instruction-following improvement plan (harness levers)

**Date:** 2026-09-30  
**Scope:** Research only — gpt-oss-20b MXFP4-Q8 on MLX; model-agnostic harness ideas where possible.  
**Sources:** `PROGRESS.md`, `_devtools/e2e/results/*`, `HANDOFF.md`, `src/agent/*`.

---

## 1. Evidence: instructions missed or wrong answers

| Case | Task / run | What was missed | Root cause |
| --- | --- | --- | --- |
| CLI shape | t09 cycles 2–5 (`t09-harder-build-gptossq8-cycle*`) | `task.md` requires `--db` **on each subcommand**; model wired global `--db` before subcommand | **Model** (spec misread); harness **task-command nudge** helped in cycle 3 but run still failed on edits |
| False “done” | t09 cycle 5 re-run | Final answer: “All specified command forms now work” while grader: `unrecognized arguments: --db` | **Harness** accepted final after weak nudge cap (`ece424d` raised cap; not re-validated on cycle 6) |
| Test names | Ollama t04 (`p15-t04-rename-symbol-ollama-r1`) | “everywhere including tests” — left `test_calc_tot` names | **Model** (Q4_K_M); MLX transcript explicitly renamed test methods |
| Hidden acceptance | t06 suite3 | Declared done without running `acceptance.py`; used `del` as variable → `SyntaxError` in `cli.py` | **Model** (keyword + over-trust own unit tests); optional **harness** gap: no `py_compile` on edited `.py` (owner declined §7.3) |
| Compile overclaim | t08 cycles 2–3 | Final says all five files compile; never `py_compile` on `main.py` | **Model**; grader passes anyway — **harness** could cross-check claimed commands vs transcript |
| Large write abort | t07 acceptance (pre-fix) | Stopped mid-`write_file` JSON, accepted as final | **Harness** (only length-truncation nudge; fixed `looksLikeAbandonedToolCall`) |
| Recovery drift | t07 cycle 2 | After abandoned `storage.py` write, generic nudge → wrote tests first | **Harness** (ambiguous nudge; fixed strict-catch `d912e59`…) |
| Import rabbit hole | t07 postfix r2 | Never `ls contacts/`; invented meta-path finders | **Model** reasoning; no harness false negative |
| Harmony / tools | gpt-oss smokes t01 | Native `run_command` not executed; 404 on replayed channel tokens | **Harness** (foreign-tool nudge, history strip `7548178`, native accept `8c41833`) |
| History fidelity | t09 msgs 41/49/63 | Whitespace collapsed in stored tool calls | **Harness** (fixed `435aaaf`) |
| Truncation loop | Large `write_file` (2026-09-30 fix) | Resent whole file → length cap → `incomplete-action-cap` | **Harness** (output token default + append chunking) |
| Wrong read args | t09 cycle 3 transcript | `line_start`/`line_end` — tool expects `start_line`/`end_line` | **Model** wrong keys; mitigated by `unknownToolArgs` did-you-mean (later harness work) |
| Fixture grader | t07 cycle 2 | Working app; `unittest discover` vs pytest-style tests | **Fixture** (retired t07) — not model/harness |

**Pattern summary:** Failures split roughly into (a) **model** misreading structured specs (CLI, rename scope, file order), (b) **harness** accepting finals or ambiguous recovery, (c) **harness** already improved (Harmony, strict-catch, task-forms, claims). Remaining gaps cluster around **holistic requirement tracking** and **evidence-backed “done”**.

---

## 2. How the harness handles instructions today

### System prompt (`src/agent/systemPrompt.ts`)

- Model-agnostic **`forge_action`** JSON contract (or optional `structuredOutput` JSON envelope).
- Mode fragment, tool docs (MCP sorted by name for prefix stability), environment facts, workspace rules, optional approved plan, orchestration block, terse style.
- Explicit rule: don’t claim file changes without `write_file`; keep going until task done.
- **Not present:** numbered requirement checklist, per-turn restatement of user constraints, or “definition of done” beyond generic text.

### Where the user task lives as context grows

- **Archival** `messages` grow append-only; **prompt view** (`contextManager.ts` `updatePromptView`) masks stale reads and compacts old turns.
- **First user message pinned verbatim** through compaction (`buildPinnedCompactedView` — summary replaces middle, not the original request).
- **Per-turn volatile context** (memory, project log, milestones, task ledger) in `buildTurnContextPrefix()` prepended to **this turn’s user message**, not `messages[0]` — preserves KV/prompt-cache prefix (`promptPrefix.ts`, PROGRESS 2026-09-30 / stable `buildSystemPrompt`).
- **Risk:** Mid-turn follow-up user messages are not separately pinned; only the **first** user blob is guaranteed post-compaction. Multi-turn chats can lose nuance from later user corrections unless they appear in recent tail or summary.

### Task ledger / plan-first

- **Task ledger** mandatory for `plan_tasks` / `spawn_subagent`; digest in turn prefix (`taskLedger.ts`).
- **`forge.planFirst.enabled`** (default off): extra no-tool call at turn start → plan snippet in turn prefix (`planFirst.ts`).
- **Orchestration toggle** changes system instructions only; does not auto-extract requirements from free text.

### claimChecker / finals

- **Unverified file claims** (narrow regex on change verbs + paths) — up to 2 nudges.
- **Claimed shell commands** in backticks vs `run_command` this turn; **per-file `py_compile`** when wording is universal (“all files”).
- **Task command forms** extracted from user message (`extractTaskCommandForms`) — ordered match, up to 3 nudges, markers on final if still unmet (`115a52b`, `ece424d`).
- **Unresolved failed `run_command`** blocks premature final.
- **Outcome mode:** optional `verifyCommand` runs after model claims done (`agentLoop.ts`).
- **Gaps:** No general checklist (bullets, “must”, file counts, output formats). Task-form logic is CLI-shaped, not full `task.md` semantics. Finals can still pass with **markers** appended while user sees overconfident text (t09 c5).

### selfCritique / bestOfN / structuredOutput

- **`selfCritique`** (default off): extra call after large `write_file` (`selfCritique.ts`).
- **`bestOfN`** (default off): sample rewrites for big replacements (`bestOfN.ts`).
- **`structuredOutput`** (default off): JSON schema tool/final envelope (`structuredOutput.ts`) — untested as default for gpt-oss Harmony.

### Thinking / temperature

- **`forge.thinking`:** default `auto` — off until 2 consecutive command failures (`thinkingForStep` in `agentLoop.ts`).
- **`forge.temperature`:** default **0.2** (`config.ts`); compaction/plan-first use 0.1.
- No per-model profile for gpt-oss (e.g. forced low temp or thinking on for spec-heavy tasks).

### Harmony (gpt-oss)

- `preprocessHarmonyReply`, `containsHarmonyControls`, native tool mapping, `assistantContentForHistory` preserves whitespace (`toolProtocol.ts`).
- Foreign-tool detection + capped nudges.

### Tool-call parsing

- `parseToolCall`, abandoned-action detection, incomplete-action nudges with **path-specific** text + `pendingActionTarget` redirect.
- No salvage of truncated JSON content (intentional — owner rejected auto-repair).

---

## 3. Proposed improvements (ranked: impact vs cost)

Impact: **H** high, **M** medium, **L** low. Cost: tokens/time per agent turn or one-time implementation.

### Tier 1 — High impact, moderate cost, cache-safe

| # | Proposal | What it does | Files (primary) | Cost | Risk | Measure | Model-agnostic? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Requirements checklist at turn start** | LLM or heuristic extract numbered requirements from first (and latest) user message; store in session state; render as `## Requirements (track each)` in **turn prefix only** | New `requirementsTracker.ts`; `chatSession.ts` / `agentLoop.ts`; optional light extract call | +0 tokens if heuristic; +1 small call if LLM extract on turn 1 only | Wrong extraction → false nudges | New eval: `t11-instruction-checklist` with 5 explicit bullets; pass = each bullet evidenced in trace | **Yes** |
| 2 | **Recency: requirements tail in turn prefix** | Each iteration, append compact checklist status (`[ ]`/`[x]` + one-line evidence) to `buildTurnContextPrefix` — **not** system message | `systemPrompt.ts` `buildTurnContextPrefix`; state updated from tools/trace | ~50–200 tokens/step in prefix tail (cache-friendly: only new tail message bytes change at end) | Noise if checklist too long | A/B on t09: % runs that wire `--db` per-subcommand before iter 20 | **Yes** |
| 3 | **Pre-final requirements gate** | Before accepting plain-text final, run deterministic checks: task forms, checklist items, “mentioned verify” vs commands run; if gaps → one structured nudge (cap 2) | `claimChecker.ts` or `requirementsGate.ts`; `agentLoop.ts` | ~0 extra model calls; small CPU | Blocking legitimate “done” with partial checklist | Unit tests from t09/t08 transcripts; e2e: finals with false claims rejected | **Yes** |
| 4 | **Harden “done” vs grader** | Headless `run_task` / optional agent hook: if task dir has `check.sh`, run once before emit final (like outcome `verifyCommand`) | `run_task.ts`, `agentLoop.ts` option | +1 command per task end | Slow/flaky checks | t09 cycle 6 pass rate; false-done count → 0 | **Yes** |

### Tier 2 — Medium impact, lower or targeted cost

| # | Proposal | What it does | Files | Cost | Risk | Measure | Agnostic? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | **Pin latest user correction** | When user sends a new message mid-session, pin that message verbatim in compaction view (second pin) or echo in turn prefix | `contextManager.ts` | Compaction complexity | Summary drift | Multi-turn eval fixture | Yes |
| 6 | **Advisory `py_compile` on `.py` write** | After successful `write_file` on `.py`, optional compile hint in tool result (not blocking) | `fileTools.ts` | +ms per write | False positives on intentional syntax errors | t06-style injection rate | Yes |
| 7 | **Final answer vs transcript audit** | If final mentions `py_compile`/`demo`/`summary`, require matching `run_command` in session (extend `evaluateClaimedCommands`) | `claimChecker.ts` | ~0 | Over-strict phrasing | t08: block “all five compile” without `main.py` compile | Yes |
| 8 | **Lower temperature / thinking for spec tasks** | Detect “exact forms” / checklist-heavy user text → `temperature=0`, `thinking=true` for first N steps | `agentLoop.ts`, `config.ts` | More decode tokens when thinking on | Slower steps | t09 wall time vs pass rate | Mostly yes |
| 9 | **`planFirst` for long first messages** | Auto-enable when user message > N chars or contains “exactly”/“must”/numbered list | `agentLoop.ts` | +1 full prefill/call per turn | Latency on simple asks | t09 iter-to-first-correct-CLI | Yes |

### Tier 3 — Situational / expensive

| # | Proposal | What it does | Files | Cost | Risk | Measure | Agnostic? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | **`structuredOutput` for gpt-oss** | Enforce JSON tool envelope | `structuredOutput.ts`, settings | May reduce Harmony parse issues; extra failures if model ignores schema | gpt-oss smoke matrix | Model-specific |
| 11 | **`selfCritique` / `bestOfN` on failure only** | Enable after failed verify or 2nd edit failure on same path | `agentLoop.ts` | +1–N calls | Latency | t03/t04 edit quality | Yes |
| 12 | **Compaction summary includes requirements** | Extend `SUMMARY_SYSTEM` to always restate open requirements | `contextManager.ts` | Summary quality variance | Lost detail | Long-run t09 with forced compaction | Yes |

### Already shipped (do not redo)

- Append-only prompt view + pinned first user message.
- Strict-catch incomplete-action nudges.
- Task-command forms + claimed-command checks.
- Harmony history + foreign-tool handling.
- Large-write append + auto `maxOutputTokens`.
- Volatile context out of system prompt (prompt-cache stability).

---

## 4. Measurement plan

### Fixtures and pass criteria

| Fixture | What it tests | Pass criteria |
| --- | --- | --- |
| **t09-harder-build** (existing) | Exact CLI + `--db` placement | `check.sh` exit 0; trace: no `task-command-nudge` on final iter; no `[unverified:task-form]` in final |
| **t08-five-file-build** (existing) | Build + honest verify claims | Pass `check.sh`; if final mentions compile, every mentioned `.py` has matching `py_compile` in trace |
| **t11-requirements** (new, small) | Checklist harness | `task.md` with 5 numbered non-CLI requirements (file names, output format); pass only if all five evidenced |
| **Regression suite** | No speed regression | `run_matrix.py` on t01,t02,t10: median wall ±15% vs baseline; cache hit % ≥ 90% on append-only steps (`mlx_prompt_cache_bench.ts`) |

### Metrics per run (from existing traces)

- `task-command-nudge`, `claimed-command-nudge`, `unverified-claim-nudge`, `verify-failed`, `incomplete-action-cap` counts.
- Iterations to first successful run of each task-form command (t09).
- Final with `unverifiedClaims` non-empty (should → 0 after gate #3).
- `promptSentTokens` / cache hit % — confirm checklist lives in tail user content, not `messages[0]` (prefix extension test in `test_v15_prompt_prefix.ts`).

### Rollout order

1. Implement #3 + #7 (deterministic, no extra model calls) + unit tests from saved `messages.json`.
2. Implement #1–2 behind `forge.requirements.enabled` (default off → on for e2e).
3. Run t09 cycle 6 + t08 once (gpt-oss Q8, MLX only).
4. If pass rate up and cache metrics stable, enable by default.

---

## 5. Executive summary (for bridge)

**Top findings:** Instruction misses are often **spec shape** (t09 CLI), **premature done** (t09 c5, t06 acceptance), or **overclaim** (t08 compile); harness already fixed many **protocol** issues (Harmony, abandoned writes, task-forms). **First user message survives compaction**; later user edits and full requirement sets do not unless restated. **claimChecker** is strong on narrow patterns, weak on holistic bullets.

**Top proposals:** (1) extract + track numbered requirements, (2) inject status in **turn prefix** each step for recency without breaking cache, (3) deterministic pre-final gate, (4) optional run `check.sh` before final on eval/tasks.

**Measurement:** Extend e2e with t11 checklist task; gate on t09/t08 + trace nudge counts + prompt-prefix stability tests.
