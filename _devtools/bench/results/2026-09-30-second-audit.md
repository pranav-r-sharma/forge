# Second independent harness audit (2026-09-30)

Branch: `v0.15.0-work` · HEAD: `b24795cac6df9dbc73882eaabf656490dc2e3ef6` · No live model loads.

Method: Re-derived from `src/` (especially `agentLoop.ts` after `9aea0a0`, `2bc0387`, `b24795c`). Did not trust `docs/HARNESS_REFERENCE.md` alone.

## Turn termination matrix

| Path | Events | User-facing honesty | Double execution notes |
|------|--------|---------------------|------------------------|
| Normal final (no tool call) | `final`, `done` | Yes; optional `unverifiedClaims`, verify note in text | Verify runs once per final attempt unless `shouldRerunVerifyAfterPass` skips (`agentLoop.ts` 924–970) |
| Foreign-tool cap (3 nudges) | `final` (+ system note), `done` | Failure explicit | No verify |
| Incomplete/truncated cap (3 nudges) | `final`, `done` | Failure explicit | No verify |
| Context full (output room 0 after compact) | `final` only | Message explains | No model call |
| User cancel (loop top / post-`chat`) | `aborted` | “(stopped)” in UI | No `done`; busy cleared in `ChatSession` `finally` |
| Provider/`chat()` error | `error` | Error entry | No `done` |
| Iteration cap | `error`, `done` | Cap message | No assistant final bubble |
| Loop detector hard stop | `error`, `done` | After one warning user-msg | Warning may precede stop (`checkLoop` 1306–1323) |
| Verify fail | continues loop | Draft shown at `verify_start`; archival gets reject note on fail (`945–947`) | Verify not double-run until writes/commands change baseline |
| Verify cancel mid-run | `aborted` | Partial verify card possible | Child killed in `verifyCheck.ts` 47–54 |

**Ordering (no tool call, `agentLoop.ts` ~767–984):** foreign detect → incomplete/truncated → unverified file claims (≤2) → task-command nudge (progress-gated, ≤3) → claimed-command (≤1) → unresolved run failure (≤1) → requirements nudge (≤`maxNudges`, skips overlap with task nudge) → assemble `unverifiedAll` → resolve verify command → optional verify run → `pushAssistant` → `final`/`done`.

**Per-turn vs session:** `LoopDetector`, nudge counters, `commandsExecutedThisTurn`, `readCoverage`, `failedRunsInARow` are per `runAgentTurn` call. `compactionCache`, `modelHistory`/`messages` archival chain persist on session. `callCounter` in `agentLoop.ts` is module-global (trace ids only).

## Prompt-cache / message mutation map

| Location | What mutates | Archival `messages` vs prompt view |
|----------|--------------|-----------------------------------|
| `updatePromptView` / mask / compact | Stubs, summary user block | **View only** when `context.appendOnly` (default true) |
| `extendRequirementsPromptView` | Checklist tail | View only; reset when mask/compact event (`agentLoop.ts` 579) |
| `hardCapOversizedMessages` | Trim huge tool results | View (legacy path) or inside update path |
| `messages[0]` system prompt | Rebuilt each turn | **Archival** — intentional |
| `pushAssistant` / tool results | Append | Archival grows append-only |
| `bestOfN` | May replace last assistant message | **Archival** (`agentLoop.ts` 1053) |
| Verify fail | `pushAssistant(fullText+note)` + user nudge | Archival |
| `preprocessHarmonyReply` | Parse only | History via `assistantContentForHistory` |

## Modes, providers, sub-agents

| Mode | Tools | Verify | Approvals | Plan-first | Requirements extract | Structured output |
|------|-------|--------|-----------|------------|---------------------|-------------------|
| agent | all + MCP | yes | writes/commands per settings | if enabled | if enabled | if enabled |
| auto/outcome | all + MCP | yes | none (dangerous cmd list remains) | if enabled | if enabled | if enabled |
| ask | read-only set | no | n/a for writes | no | if enabled (depth 0) | if enabled |
| plan | none | no | n/a | no | if enabled | **off** |
| sub-agent (`spawn_subagent`) | auto child | **not passed** | auto | **not in sub options** | **off** (`subAgentDepth>0`) | inherits parent cfg |

Provider: chat/agent uses `forge.provider`; embeddings + Tab FIM fall back to Ollama when MLX/openai-compat lack capability (`factory.ts` 41–44). Requirements extraction is heuristic-only (`requirements.ts`).

## Tools (validation / safety)

- **Nested args:** `unwrapNestedToolCall` after parse (`agentLoop.ts` 1062).
- **Unknown args:** `unknownArgNotesForSpec` appended to successful tool results (`1188–1191`).
- **run_command:** `resolveRunCommandString` accepts argv arrays (`argErrors.ts` 33–37); approval + `isDangerousCommand` run on resolved string; detached process group in `commandTool.ts`.
- **write_file append:** rejects missing file, rejects combine with search/replace; concatenates `existing + content` in memory.
- **verify-before-done:** separate spawn path; filters dangerous/chained custom commands (`verifyBeforeDone.ts` 46–52).

## Findings


| Sev | Scenario | Evidence | Suggested fix | Status |
|-----|----------|----------|---------------|--------|
| **risk** | `forge.mlx.contextTokens` / panel context window changes do not restart `mlx_lm.server` | `extension.ts`; `mlxServer.ts` `doEnsure` key | Restart when contextTokens changes | **fixed** (second-audit code pass) |
| **risk** | MLX settings change mid-turn races `ensureMlx()` | `extension.ts`; `chatSession.ts` | Defer restart until turn ends | **fixed** (`mlxRestartCoord.ts`) |
| **risk** | `thinking: default` coerced to `auto` | `config.ts`; `thinkingForStep` | Map `default` → model default | **fixed** |
| **risk** | Requirements gate soft after nudges exhausted | `agentLoop.ts`; `requirements.ts` | Final lists unmet checkable items | **fixed** (`formatRequirementsFinalUnmetSection`) |
| **risk** | `write_file` append unbounded | `fileTools.ts` | `maxContextFileKB` guard | **fixed** |
| **risk** | Verify spawn without kill tree | `verifyCheck.ts` | `shellProcessTree.ts` | **fixed** |
| **cosmetic** | Loop/iteration cap no `final` | `agentLoop.ts` | `final`+`done` | **fixed** |
| **cosmetic** | Loop detection setting copy | `package.json` | Doc fix | **fixed** |
| **cosmetic** | Verify cancel / context-full missing `done` | `agentLoop.ts` | Emit `done` | **fixed** |
| **cosmetic** | System prompt rewrite every turn | `agentLoop.ts` | (cache optimization — deferred) | **not an issue** (byte-identical when turn-stable inputs unchanged; `test_v15_promptview.ts` `testRealLoop`, `test_v15_prompt_prefix.ts`, `test_v11.ts`) |
| **cosmetic** | Sub-agent model wording Ollama-only | `package.json` `subAgentModel` | Wording | **fixed** |


## First audit (`de94213` / §4) — missed or imprecise


1. **§4 “Fixed” rows** — Several first-audit fixes are present in code (split foreign/incomplete counters, deferred `pushAssistant` until verify passes, `skipWhenWorkspaceProgress` on verify loop, settings panel keys for provider/thinking/trace/append-only). This pass did **not** re-litigate those as open bugs.
2. **`mlx.contextTokens` vs server restart** — Not listed in first audit §4; changing context window in UI updates Forge math only.
3. **`thinking: default` vs coercion to `auto`** — Enum/default mismatch not captured.
4. **Loop detector scope** — Described as Auto/Outcome-only in settings copy; code applies whenever enabled.
5. **Turn end event matrix** — First audit focused on verify transcript ordering; less on `done`/`final`/`error`/`aborted` asymmetry.
6. **Requirements hard gate** — First audit split nudge vs gate gaps; did not note finals still ship after max nudges with markers only.
7. **write_file append size** — First audit covered read trimming; not append OOM on large existing files.
8. **Overstated “panel gap”** — Post-`c42aeb7` many keys are on allowlist; remaining gaps are mostly URLs, models, routing, water marks, webSearch TTL/blocked domains, MCP, hooks-related keys (expected JSON-only).


## Settings table (all `package.json` `contributes.configuration` keys)

| Key | package.json default | `getConfig()` fallback | default==fallback? | read in `src/`? | settings panel? | restart / notes |
|-----|---------------------|------------------------|-------------------|-----------------|-----------------|-----------------|
| `autoApproveCommands` | ['^git status', '^git diff', '^git log', '^ls\\b', '^cat\\b' | [] | ~ | Y | no | — |
| `autoModeMaxIterations` | 100000 | 100000 | Y | Y | yes | — |
| `bestOfN.enabled` | False | false | ~ | Y | yes | — |
| `bestOfN.samples` | 3 | 3 | Y | Y | yes | — |
| `chatModel` |  | '' | Y | Y | no | — |
| `completionDebounceMs` | 250 | 250 | Y | Y | no | — |
| `completionModel` |  | '' | Y | Y | no | — |
| `context.appendOnly` | True | true | ~ | Y | yes | — |
| `context.highWaterPct` | 75 | 75 | Y | Y | no | — |
| `context.lowWaterPct` | 45 | 45 | Y | Y | no | — |
| `context.pinnedUserMaxChars` | 40000 | max(2000, floor(...)) | ~ | Y | yes | — |
| `contextChunkCount` | 24 | 24 | Y | Y | no | — |
| `embeddingModel` | nomic-embed-text | 'nomic-embed-text' | Y | Y | no | — |
| `enableTabCompletion` | True | true | ~ | Y | no | — |
| `keepAliveMinutes` | -1 | -1 | Y | Y | yes | — |
| `loopDetection.enabled` | True | true | ~ | Y | yes | — |
| `maxAgentIterations` | 200 | 200 | Y | Y | yes | — |
| `maxContextFileKB` | 8192 | 8192 | Y | Y | yes | — |
| `maxOutputTokens` | 0 | 0 | Y | Y | yes | — |
| `maxOutputTokensCeiling` | 0 | 0 | Y | Y | yes | — |
| `maxSubAgentDepth` | 2 | 2 | Y | Y | yes | — |
| `mcp.servers` | [] | [] | Y | Y | no | Reload MCP command |
| `mlx.autoStart` | True | true | ~ | Y | no | — |
| `mlx.baseUrl` | http://127.0.0.1:8123 | default `http://127.0.0.1:8123` | ~ | Y | no | MLX restart |
| `mlx.contextTokens` | 131072 | 131072 | Y | Y | via panel `numCtx` remap | MLX restart when changed (managed server key) |
| `mlx.decodeConcurrency` | 0 | 0 | Y | Y | yes | MLX restart |
| `mlx.draftModel` |  | '' | Y | Y | yes | MLX restart |
| `mlx.extraArgs` | [] | [] | Y | Y | no | MLX restart |
| `mlx.extraModelFolders` | [] | [] | Y | Y | no | — |
| `mlx.model` |  | '' | Y | Y | no | MLX restart |
| `mlx.modelLibraryPath` | ~/.cache/huggingface/hub | empty/null → `~/.cache/huggingface/hub` via IIFE | ~ | Y | no | — |
| `mlx.numDraftTokens` | 0 | 0 | Y | Y | yes | MLX restart |
| `mlx.prefillStepSize` | 0 | 0 | Y | Y | yes | MLX restart |
| `mlx.promptCacheGB` | 32 | 32 | Y | Y | yes | MLX restart |
| `mlx.promptCacheSize` | 0 | 0 | Y | Y | yes | MLX restart |
| `mlx.promptConcurrency` | 0 | 0 | Y | Y | yes | MLX restart |
| `mlx.pythonPath` |  | '' | Y | Y | no | MLX restart |
| `modelRouting` | {} | see package default | ~ | Y | no | — |
| `numCtx` | 131072 | Ollama: `numCtx ?? 131072`; else `mlx.contextTokens ?? 131072` | Y | Y | yes | no server restart (Forge-only meter/compaction) |
| `ollama.numBatch` | 0 | 0 | Y | Y | yes | — |
| `ollamaBaseUrl` | http://localhost:11434 | default `http://localhost:11434` | ~ | Y | no | — |
| `openaiCompat.baseUrl` | http://127.0.0.1:1234 | default `http://127.0.0.1:1234` | ~ | Y | no | — |
| `planFirst.enabled` | False | false | ~ | Y | yes | — |
| `provider` | mlx | parsed via `parseProviderId` | ~ | Y | yes | stop MLX if leaving mlx |
| `requireApprovalForCommands` | True | true | ~ | Y | yes | — |
| `requireApprovalForWrites` | True | true | ~ | Y | yes | — |
| `requirements.enabled` | False | false | ~ | Y | yes | — |
| `requirements.maxNudges` | 2 | max(0, floor(...)) | ~ | Y | yes | — |
| `requirements.showInPrompt` | True | true | ~ | Y | yes | — |
| `selfCritique.enabled` | False | false | ~ | Y | yes | — |
| `selfCritique.minLines` | 40 | 40 | Y | Y | yes | — |
| `showStatusMessages` | True | true | ~ | Y | yes | — |
| `singleMessageSharePct` | 25 | clamp 5–80, default 25 | ~ | Y | yes | — |
| `structuredOutput.enabled` | False | false | ~ | Y | yes | — |
| `subAgentMaxIterations` | 200 | 200 | Y | Y | yes | — |
| `subAgentModel` |  | '' | Y | Y | yes | — |
| `taskLedger.costAwarePlanning` | True | true | ~ | Y | yes | — |
| `taskLedger.expensivePlanReviewThreshold` | 8 | 8 | Y | Y | yes | — |
| `taskLedger.reviewExpensivePlans` | True | true | ~ | Y | yes | — |
| `temperature` | 0.2 | 0.2 | Y | Y | yes | — |
| `terseSteps` | True | true | ~ | Y | yes | — |
| `thinking` | auto | `off`|`on`|`auto`|`default`; other → `auto` | ~ | Y | yes | `default` → model default in API |
| `trace.enabled` | True | true | ~ | Y | yes | — |
| `verifyBeforeDone` | auto | `off`|`custom`; else `auto` | ~ | Y | yes | — |
| `verifyCommand` |  | '' | Y | Y | yes | — |
| `verifyTimeoutSec` | 300 | max(30, floor(...)) | ~ | Y | yes | — |
| `webSearch.blockedDomains` | [] | [] | Y | Y | no | — |
| `webSearch.cacheTtlMinutes` | 10 | 10 | Y | Y | no | — |
| `webSearch.enabled` | False | false | ~ | Y | yes | — |
| `webSearch.maxFetchChars` | 2000000 | 2_000_000 | ~ | Y | no | — |
| `webSearch.maxResults` | 8 | 8 | Y | Y | yes | — |
| `webSearch.provider` | auto | 'auto' | Y | Y | yes | — |
| `webSearch.respectRobotsTxt` | True | true | ~ | Y | yes | — |
| `webSearch.searxngUrl` |  | '' | Y | Y | yes | — |
| `webSearch.timeoutMs` | 15000 | 15000 | Y | Y | no | — |
