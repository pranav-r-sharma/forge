# Forge harness reference

Last updated: 2026-09-30 (introducing commit: see `git log -1 -- docs/HARNESS_REFERENCE.md`)

Living map of agent-turn behavior: features, settings, execution order, and known interaction risks. **Do not treat this as a substitute for reading `src/agent/agentLoop.ts` when changing behavior.**

---

## 1. Feature inventory (59)

Each item: **purpose · trigger · location · settings · mutates**

### Turn bootstrap

| ID | Feature | Purpose | Trigger | Key code | Settings (default) | Mutates |
|----|---------|---------|---------|----------|-------------------|---------|
| F1 | Agent loop & step caps | ReAct loop until final or cap | Every turn | `agentLoop.ts` `runAgentTurn` | `maxAgentIterations` 200; `autoModeMaxIterations` 100000 | Events, messages |
| F2 | Mode definitions | Tool allow-list + prompt fragment | `options.mode` | `modes.ts`, `toolsAllowedInMode` | — | System prompt, tool errors |
| F3 | System prompt | Tools, action contract, terse style | Turn start | `systemPrompt.ts` `buildSystemPrompt` | `terseSteps` true; `structuredOutput.enabled` false | `messages[0]` |
| F4 | Environment facts | PATH/project test hints in system | Turn start | `environment.ts`; session wiring | — | System prompt |
| F5 | Turn context prefix | Memory, log, milestones, ledger on **user** tail (KV-stable) | Turn start | `buildTurnContextPrefix`; `agentLoop.ts` ~379–407 | — | First user message |
| F6 | Plan-first | Extra planning LLM call + inject plan (cost: one full LLM round before the loop) | `planFirst.enabled` + agent/auto/outcome | `planFirst.ts` | default **false** | User message prefix |
| F7 | Requirements extract | Heuristic checklist from user text | `requirements.enabled`, depth 0 only | `requirements.ts` | enabled **false**; `maxNudges` 2; `showInPrompt` true | In-memory state |
| F8 | Structured output | Ollama `format` JSON envelope | `structuredOutput.enabled`, mode ≠ plan | `structuredOutput.ts`, `resolveModelResponse` | **false** | Request format; parsing |
| F9 | Autonomous approvals | Skip write/command approval | auto/outcome | `isAutonomousMode`; `approvalBroker` | `requireApprovalForWrites/Commands` true (ignored) | Tool ctx |
| F10 | Sub-agent spawn | Nested `runAgentTurn` in auto | `spawn_subagent` | `agentLoop.ts` ~428–517; `subAgentTool.ts` | `subAgentModel` ''; `subAgentMaxIterations` 200; `maxSubAgentDepth` 2 (hard max 4) | Parent tool result only |
| F11 | Task ledger hooks | Ledger rows on spawn/plan | Tools + spawn | `taskLedger.ts`, `taskCost.ts` | `costAwarePlanning` true; review threshold 8 | Ledger text in prefix |
| F12 | Trace JSONL | Per-iteration metrics | `trace.enabled` | `traceLog.ts` | **true** | `.forge/traces/` |
| F13 | Read coverage | Turn-local read ranges | Turn init | `readCoverage.ts` | — | Tool notes, trace |

### Prompt view / context (each iteration)

| ID | Feature | Purpose | Trigger | Key code | Settings | Mutates |
|----|---------|---------|---------|----------|----------|---------|
| F14 | Append-only prompt view | Batch mask/compact for MLX/Ollama prefix reuse | `context.appendOnly` **true** | `contextManager.ts` `updatePromptView` | `highWaterPct` 75; `lowWaterPct` 45 | **Prompt view only** |
| F15 | Legacy prune path | Per-step stale reads + compact | `context.appendOnly` false | `pruneStaleReadsView`, `maybeCompact` | same `numCtx` | Prompt view |
| F16 | Stale read supersede | Stub old `read_file` results | Write-after-read, covering read, age | `contextManager.ts` | KEEP_RECENT 6 tool results | Prompt stubs |
| F17 | LLM compaction summary | Fold old turns into summary user msg | High water / char budget | `maybeCompact`, `buildPinnedCompactedView` | `context.pinnedUserMaxChars` 40000 | Prompt view |
| F18 | Pinned user compaction | Keep first + recent user msgs verbatim in summary | Compact event | `pinnedUserCompaction.ts` | pin budget scales with low-water | Prompt view |
| F19 | Oversized message cap | Position-independent char cap | Each prompt build | `capOversizedStable`, `singleMessageSharePct` | 25% of ctx chars | Prompt truncation |
| F20 | Chars-per-token EMA | Token estimate from real counts | After model call (append-only) | `updateCharsPerToken` | persisted `cpt` in compaction cache | Estimates |
| F21 | Requirements checklist tail | Live checklist on prompt view | `requirements.showInPrompt` | `extendRequirementsPromptView` | — | Appended user blocks (not archival) |
| F22 | Prompt prefix diagnostics | Detect prefix extension (tests) | — | `promptPrefix.ts` | — | None at runtime |

### Model call

| ID | Feature | Purpose | Trigger | Key code | Settings | Mutates |
|----|---------|---------|---------|----------|----------|---------|
| F23 | Provider routing | Ollama / MLX / OpenAI-compat | `forge.provider` | `factory.ts` `SwitchableProvider` | default **mlx** | Client, embed/FIM fallback |
| F24 | MLX server manager | Start/adopt/stop `mlx_lm.server` | MLX provider | `mlxServer.ts` | `mlx.*` (model, pythonPath, autoStart, promptCacheGB, extraArgs, contextTokens, …) | Process lifecycle |
| F25 | Model routing per mode | Session > routing > chatModel | Send | `resolveModelForMode` | `modelRouting`, `chatModel` | Model id |
| F26 | Thinking | off/on/auto (2 fails → on) | Each iter | `thinkingForStep` | `thinking` **auto** | LLM option |
| F27 | Max output tokens | Avoid silent 512 default; prompt-aware cap | Each iter | `resolveEffectiveMaxOutputTokens` + `promptViewTokenEstimate` (max of fresh chars/ cpt and prior step est.); if cap ≤ 0 → `forceCompactionForOutput` on `updatePromptView` once, then **final** “context is full” if still ≤ 0 (never call model without a positive cap; `MIN_AGENT_OUTPUT_TOKEN_FLOOR` 2048 is the design target for auto headroom) | `maxOutputTokens` **0**=auto clamped to ctx−prompt−safety; explicit clamped too; `maxOutputTokensCeiling` 0 | `maxTokens` (&gt;0 only on wire; clients warn on 0) |
| F28 | numCtx / compaction window | Context for compaction + Ollama | Each iter | `getConfig().numCtx` | Ollama: `numCtx` 131072; else `mlx.contextTokens` 131072 | LLM + thresholds; context meter ceiling (used = full prompt incl. cache + reply, `contextUsedTokens`) |
| F29 | Harmony preprocess | Split analysis/final channels | Every reply | `toolProtocol.ts` | — | Parse source vs display |
| F30 | Tool call parsing | `forge_action` fence, native accept | After LLM | `parseToolCall`, `tryAcceptNativeToolCall`, `resolveModelResponse` | — | `call`, display text |
| F31 | Plan mode | No tools; plain answer | `mode==='plan'` | `agentLoop.ts` ~710 | — | Final text only |

### Post-reply gates (no parsed tool)

| ID | Feature | Purpose | Trigger | Key code | Cap | Mutates |
|----|---------|---------|---------|----------|-----|---------|
| F32 | Foreign tool detect | Native/Harmony/XML shapes | No fence call | `detectForeignToolCall` | — | Accept or nudge |
| F33 | Foreign tool nudge | Force ```forge_action``` | F32, not accepted | `formatForeignToolCallNudge` | **3** foreign† | User msg |
| F34 | Length truncation nudge | `finishReason==='length'` | No call | `formatIncompleteActionNudge` | **3** incomplete† | User msg; `pendingActionTarget` |
| F35 | Abandoned action nudge | Mid-JSON tool fragment | `looksLikeAbandonedToolCall` | same as F34 | **3** incomplete† | User msg; append hint |
| F35b | Stalled reply nudge | Empty/reasoning-only reply, or last sentence promises an action with no tool call ("Now I'll write the tests:"); questions to the user and "let me know" closers excluded; skipped in Plan | No call, not incomplete | `classifyStalledReply`, `formatStalledReplyNudge` | **2** stalled (own counter); after cap: normal final path (empty → explanatory text) | User msg |
| F36 | Incomplete cap failure | Stop with system note | † exhausted | `formatIncompleteActionCapFailure` | — | **Final** (failure) |
| F37 | Unverified file claim | Said edited path, no write_file | Final path | `findUnverifiedClaims` | **2** | User msg |
| F38 | Task command forms | User-specified cmd shapes not run | Final | `formatTaskCommandNudge` | **3** (progress-gated) | User msg |
| F39 | Claimed command | Said ran `\`cmd\``; per-file gaps | Final | `evaluateClaimedCommands` (task forms via F38 only) | **1** | User msg |
| F40 | Unresolved run failure | Final after failed run_command | `unresolvedRunFailure` | `formatUnresolvedFailureNudge` | **1** | User msg |
| F41 | Requirements gate nudge | Checkable items missing evidence | Final | `formatRequirementsGateNudge`; after nudges exhausted `formatRequirementsFinalUnmetSection` on final text | `requirements.maxNudges` 2; skips overlap w/ F38 | User msg + final list |
| F42 | Final unverified markers | UI tags on bubble | After nudges exhausted | `agentLoop.ts` ~846–858 | — | `final.unverifiedClaims` |
| F43 | Verify before done | Shell check before accept | Final; agent/auto/outcome | `resolveVerifyCommandForFinal`, `runVerifyCommand` | `verifyBeforeDone` **auto**; `verifyCommand`; `verifyTimeoutSec` 300; session `verifyCommand` wins | Run cmd; fail → continue |
| F44 | Verify gaming warning | Heuristic bypass scan | Pass after prior fail | `gamingDetection.ts` | — | UI warning only |
| F45 | Pending action redirect | Finish interrupted write | After incomplete nudge | `pendingActionTarget` | 1 redirect | User msg |

† **Separate counters:** `foreignFormatNudges` and `incompleteActionNudges` in `agentLoop.ts` (~584, 724–728, 750–753) each cap at **3** (foreign-tool vs incomplete/abandoned nudges no longer share one budget).

### Tool execution

| ID | Feature | Purpose | Trigger | Key code | Settings | Mutates |
|----|---------|---------|---------|----------|----------|---------|
| F46 | Best-of-N rewrite | Resample large full-file writes | write_file ≥40 lines existing | `bestOfN.ts` | enabled **false**; samples 3 | May replace call + assistant msg |
| F47 | Nested tool unwrap | `tool` nested in `args` | Every call | `argErrors.ts` | — | Normalized args |
| F48 | Unknown tool args | Hint typos in result | Successful tool | `unknownToolArgs.ts` | — | Tool result text |
| F49 | Redundant read note | Same lines re-read | read_file ok | `readCoverage.ts` | — | Tool result + trace |
| F50 | Self-critique | Extra model review of edit | write_file ok, lines ≥ min | `selfCritique.ts` | enabled **false**; minLines 40 | Tool result appendix |
| F51 | write_file append | Chunk large creates | `append:true` | `fileTools.ts` | `maxContextFileKB` on existing+append bytes | File bytes |
| F52 | Edit engine | search/replace, reindent, dup-def warn | write_file | `fileTools.ts`, `editApply.ts` | — | Files + echo region |
| F53 | Forge hooks | `.forge/hooks/*` stdin JSON | write/command | `hooks.ts` | — | Block/allow |
| F54 | MCP tools | `mcp__server__tool` | agent/auto/outcome | `mcpManager.ts` | `mcp.servers` [] | Same pipeline |
| F55 | Loop detector | Repeat signature → warn/stop | After tool + verify fail step | `loopDetector.ts` `checkLoop` | `loopDetection.enabled` true; **`check_background_command` exempt** | User warn or error+done |
| F56 | Tool abort race | Cancel doesn't hang | Cancellation | `raceToolCallWithCancellation` | 4000 ms grace | Synthetic fail result |
| F57 | Command cwd resolve | Fix workspace name as cwd | run_command | `commandTool.ts` / session | — | spawn cwd |
| F58 | Web search/fetch | Optional tools | `webSearch.enabled` | `webTools.ts`, services | default **false** | Tool availability |

**Also wired but outside the main loop:** inline edit / Tab completion (`inlineEditController`, `inlineCompletionProvider`), workspace `@codebase` index, memory review, checkpoints, skills/rules injection (`chatSession.ts`), settings recommendations UI (`recommendations.ts`), chat store persistence.

---

## 2. Settings table

Read via `getConfig()` in `src/util/config.ts` unless noted. **Panel?** = listed in `SETTINGS_PANEL_KEYS` (webview may write). **Apply** = machine recommendations UI (`recommendations.ts`) may suggest values; writing still goes through VS Code config (panel allowlist or settings.json).

| Key | Default (package.json / code) | Panel? | Effect |
|-----|------------------------------|--------|--------|
| `forge.provider` | mlx | Yes | LLM backend |
| `forge.ollamaBaseUrl` | localhost:11434 | No | Ollama URL |
| `forge.mlx.baseUrl` | 127.0.0.1:8123 | No | MLX server URL |
| `forge.mlx.model` | "" | No | HF folder / id |
| `forge.mlx.contextTokens` | (see package) | Via `numCtx` remap when provider≠ollama | Server ctx + compaction |
| `forge.mlx.autoStart` | true | No | Managed server |
| `forge.mlx.promptCacheGB` | — | Yes | Server `--prompt-cache-bytes` |
| `forge.mlx.extraArgs` | [] | No | Extra server flags (blocked: trust-remote-code, host, port, model) |
| `forge.numCtx` | 131072 | Yes (→ `mlx.contextTokens` when MLX) | Ollama per-request window |
| `forge.chatModel` / `completionModel` / `embeddingModel` | — | No | Model ids |
| `forge.temperature` | 0.2 | Yes | Sampling |
| `forge.maxAgentIterations` | 200 | Yes | Step cap (non-auto) |
| `forge.autoModeMaxIterations` | 100000 | Yes | Auto/outcome cap |
| `forge.maxOutputTokens` | 0 (auto) | Yes | Generation cap; explicit values clamped to ctx−prompt−safety |
| `forge.maxOutputTokensCeiling` | 0 | Yes | Caps auto mode only |
| `forge.thinking` | auto | **Yes** | Thinking toggle |
| `forge.terseSteps` | true | **Yes** | System brevity |
| `forge.context.appendOnly` | true | **Yes** | Append-only vs legacy prune |
| `forge.context.highWaterPct` / `lowWaterPct` | 75 / 45 | **No** | Compaction batch thresholds |
| `forge.context.pinnedUserMaxChars` | 40000 | Yes | Pin budget in compaction |
| `forge.singleMessageSharePct` | 25 | Yes | Oversized msg cap |
| `forge.trace.enabled` | true | **Yes** | JSONL trace |
| `forge.loopDetection.enabled` | true | Yes | Loop detector |
| `forge.structuredOutput.enabled` | false | Yes | JSON envelope |
| `forge.planFirst.enabled` | false | Yes | Plan-first pass |
| `forge.requirements.*` | off, 2, true | Partial (not `enabled` default in panel list — **enabled is in panel**) | Checklist + nudges |
| `forge.verifyBeforeDone` | auto | Yes | Definition-of-done |
| `forge.verifyCommand` / `verifyTimeoutSec` | "" / 300 | Yes | Custom verify |
| `forge.selfCritique.*` / `forge.bestOfN.*` | off | Yes | Post-edit extras |
| `forge.taskLedger.*` | on / on / 8 | Yes | Plan cost gates |
| `forge.webSearch.*` | off | Partial | Web tools |
| `forge.requireApprovalForWrites/Commands` | true | Yes | Agent mode approvals |
| `forge.subAgent*` | — | Yes | Delegation |
| `forge.mcp.servers` | [] | No | MCP tool surface |

Per-chat overrides (not in table): session model, Outcome **verify command** (`ChatSession.verifyCommand`), orchestration toggle, compaction cache blob.

---

## 3. Interactions & order of operations

### Turn setup (once)

```
buildSystemPrompt → messages[0]
requirements extract? (depth 0)
buildTurnContextPrefix + planFirst? → push user message
extractTaskCommandForms → state for F38/F41
spawnSubAgent closure, toolCtx, loopDetector reset, readCoverage new
```

### Each iteration

```
cancel? → aborted
buildPromptView (append-only OR legacy prune/compact/hardCap + requirements tail)
LLM chat (thinking, maxTokens, numCtx, structured format?)
updateCharsPerToken?
parse response (plan → no tools)
foreign tool? → accept OR foreignFormatNudge++ → continue OR cap final
incomplete (length|abandoned)? → incompleteActionNudge++ → continue OR cap final
if NO tool call (final candidate chain — at most ONE nudge per iteration):
  1 unverified claims (≤2)
  2 task command forms (≤3, progress gated)
  3 claimed commands (≤1)
  4 unresolved run failure (≤1)
  5 requirements gate (≤maxNudges, skip if overlaps task forms)
  → push assistant; verify command?
     fail → user nudge; checkLoop(__verify__); continue
     pass → gaming warning?; final + done
if tool call:
  push assistant → pending redirect? → bestOfN? → unwrap nested
  mode gate / hooks → run tool → self-critique / unknown args / redundant read
  push tool result user msg; truncationNudges=0
  checkLoop (except check_background_command when enabled)
```

### ASCII: final-answer gate chain (one pass per iteration)

```
Model reply (no tool)
        │
        ▼
┌───────────────────┐
│ Foreign / incomplete│──(shared cap 3)──► continue or cap-fail final
└─────────┬─────────┘
          ▼
   empty / announced-only? ──► continue (≤2)
          ▼
   unverified files? ──► continue (≤2)
          ▼
   task cmd forms? ──► continue (≤3)
          ▼
   claimed cmds? ──► continue (≤1)
          ▼
   unresolved fail? ──► continue (≤1)
          ▼
   requirements? ──► continue (≤2, dedupe task)
          ▼
   push assistant to history
          ▼
   verify before done? ──fail──► continue (+ loop detect)
          │ pass
          ▼
      emit final + done
```

### Cache stability intent

- **Stable prefix:** system prompt + growing **archival** assistant/tool chain in append-only mode; deliberate **batch** stubbing at high water, not per-step rewrites (`context.appendOnly`).
- **Mutable tail:** turn context prefix on first user message; requirements checklist blocks appended to **prompt view** only (`requirements.ts` ~425–437).
- **Breaking prefix:** legacy `appendOnly=false` rewrites stale reads each step; any compaction replaces middle with summary (batch in append-only).

---

## 4. Known conflicts / open issues

Verified by reviewer 2026-09-30: row 1 re-classified (false positive).

| Sev | Issue | Scenario | Evidence | Suggested fix (not implemented in audit) |
|-----|-------|----------|----------|----------------------------------------|
| **cosmetic** | Send-path health error toast always mentions Ollama | User on MLX (or other active provider) sees misleading toast if health fails | `formatForgeHealthErrorToast` (`providerHealth.ts`); `chatSession.ts` send path | **Fixed 2026-09-30:** provider-specific toast (MLX / Ollama / openai-compat) |
| **risk** | Shared `truncationNudges` | Model emits 3 foreign-format attempts then hits length truncation → cap failure without incomplete recovery | `agentLoop.ts` 584, 724–728, 750–753 | **Fixed 2026-09-30:** split `foreignFormatNudges` / `incompleteActionNudges` |
| **risk** | Assistant “done” before verify fail | Model final text pushed (~859) then verify fails → transcript shows success wording while loop continues | `agentLoop.ts` 859–899 | **Fixed 2026-09-30:** defer `pushAssistant` until verify passes; on fail append corrective system note |
| **risk** | Session verify ignores `turnWroteFiles` | Outcome chat sets verify cmd; model answers without edits → verify still runs | `resolveVerifyCommandForFinal`; `shouldRerunVerifyAfterPass` in `agentLoop.ts` | **Fixed 2026-09-30:** intentional (session verify every final); skip repeat verify when no writes/commands since last pass |
| **risk** | Loop detector vs verify retries | Repeated identical verify command + same output counts toward loop; may halt Outcome iteration | `agentLoop.ts` 896 `checkLoop(..., '__verify__', ...)`; `loopDetector.ts` | **Fixed 2026-09-30:** skip loop when `writesSinceLastVerify` had progress |
| **risk** | Loop detector vs chunked reads | Four rotating read ranges can trip “cycle” rule (by design) | `loopDetector.ts` 22–23, 90–99 | **Fixed 2026-09-30:** exempt only first-pass chunked reads (new line ranges since last write); repeat passes still trip on step 16 |
| **risk** | Settings panel gap | `thinking`, `terseSteps`, `context.appendOnly`, `trace.enabled`, `provider`, MLX model path not in allowlist | `config.ts` `SETTINGS_PANEL_KEYS` | **Fixed 2026-09-30:** added to allowlist + panel UI (provider/thinking/terse/append-only/trace) |
| **risk** | `numCtx` panel vs MLX | Panel writes `numCtx` but storage remaps to `mlx.contextTokens` when provider≠ollama | `setForgeSetting` 353–355 | **Fixed 2026-09-30:** label “Context window (MLX)” / “(Ollama)” in settings panel |
| **risk** | Recommendations vs explicit settings | Apply may overwrite user-tuned ctx/output | `recommendations.ts` + panel | **Fixed 2026-09-30:** Apply all skips user-configured keys; “(you set X)” on reco rows |
| **risk** | Compaction + checklist + pins | Large pinned users + requirements tail + summary can still approach window; low-water loop escalates keep-N | `updatePromptView` `reservedTailTokens`; `requirementsChecklistMaxChars` | **Fixed 2026-09-30:** reserve tail in water marks; cap checklist ~5% ctx |
| **risk** | Auto output cap vs huge ctx | Auto = max(ctx/2, 16384) — on 131k ctx allows ~65k gen; still independent of prompt size (runtime may OOM) | `resolveEffectiveMaxOutputTokens` (+ prompt est. in loop) | **Fixed 2026-09-30:** prompt-aware cap + safety margin |
| **risk** | Zero `maxTokens` omits cap → MLX 512 default | Prompt fills window; stale under-estimate → `resolve` returns 0; truthy check skips `max_tokens` | `agentLoop.ts`; `openaiCompatClient.ts`; `ollama/client.ts` | **Fixed 2026-09-30:** `promptViewTokenEstimate`; compact-or-abort floor 2048; explicit &gt;0 wire guard + warn on 0 |
| **cosmetic** | `findRequirementsGateGaps` ≡ nudge gaps | Same filter for markers and nudges; judgment items never nudged | `findRequirementsNudgeGaps` vs `findRequirementsGateGaps` + `openJudgmentRequirementNotes` | **Fixed 2026-09-30:** split + documented roles |
| **cosmetic** | MCP comment vs name | Comment says `mcp_<server>_<tool>`; runtime `mcp__server__tool` | `agentLoop.ts` ~332 | **Fixed 2026-09-30:** comment matches `mcp__` |
| **cosmetic** | `evaluateClaimedCommands` API | Could embed task forms if caller passes forms; loop passes `[]` deliberately | `claimChecker.ts`; F38 in loop | **Fixed 2026-09-30:** task forms removed from API |
| **cosmetic** | Sub-agent feature subset | No requirements extract, empty history, auto mode; shares memory/log | `spawn_subagent` tool describe in `tools/index.ts` | **Fixed 2026-09-30:** documented in tool description |
| **cosmetic** | Plan-first double user content | Plan call and main turn both see raw user message | F6 inventory | **Fixed 2026-09-30:** documented cost (kept behavior) |

### Second audit (2026-09-30, report `_devtools/bench/results/2026-09-30-second-audit.md`)

| Sev | Issue | Scenario | Evidence | Status |
|-----|-------|----------|----------|--------|
| **risk** | `mlx.contextTokens` vs running server | Context panel change must restart managed MLX server | `extension.ts`; `mlxServer.ts` `doEnsure` key includes `contextTokens` | **Fixed 2026-09-30** (second-audit pass) |
| **risk** | MLX restart during active turn | Mid-turn settings change must not restart under `chat()` | `mlxRestartCoord.ts`; `chatSession.ts` turn hooks | **Fixed 2026-09-30:** defer + status bar “MLX restart pending…” |
| **risk** | `thinking: default` coercion | `default` must mean model default (`undefined` in API) | `config.ts`; `thinkingForStep` | **Fixed 2026-09-30** |
| **risk** | Soft requirements gate | After `maxNudges`, final must list unmet checkable items | `formatRequirementsFinalUnmetSection`; `agentLoop.ts` final path | **Fixed 2026-09-30:** soft gate + explicit final list |
| **risk** | Append OOM | `write_file` append size guard | `fileTools.ts` (`maxContextFileKB`) | **Fixed 2026-09-30** |
| **risk** | Verify spawn hang | Verify uses process-group kill tree | `shellProcessTree.ts`; `verifyCheck.ts` | **Fixed 2026-09-30** |
| **cosmetic** | Uneven terminal events | Loop/iteration caps emit `final`+`done` | `checkLoop`; iteration cap in `agentLoop.ts` | **Fixed 2026-09-30** |
| **cosmetic** | Loop detection scope copy | Setting description matches all modes | `package.json` `loopDetection.enabled` | **Fixed 2026-09-30** (doc) |
| **cosmetic** | Missing `done` on some exits | Context-full + verify cancel | `agentLoop.ts` | **Fixed 2026-09-30** |
| **cosmetic** | Sub-agent model copy | Wording not Ollama-only | `package.json` `subAgentModel` | **Fixed 2026-09-30** |

### Owner-reported issues (2026-10-03)

| Sev | Issue | Scenario | Evidence | Status |
|-----|-------|----------|----------|--------|
| **bug** | Context meter always low | Meter summed `promptTokens` (EVALUATED only, cached prefix excluded) + reply; warm cache → ~2% of real prompt (trace: 96 evaluated vs 5131 cached) | `contextUsage.ts` `contextUsedTokens`; `chatViewProvider.ts` `buildHwStatus`; metrics event carries `estPromptTokens` | **Fixed 2026-10-03:** full prompt = `promptTotalTokens` → evaluated+cached → max(estimate, evaluated) (Ollama) + reply |
| **bug** | Abrupt stops mid-task | No-tool reply was always taken as final: an empty reply or "Now I'll do X:" without the action ended the turn | F35b; `test_v15_stalled_reply.ts` | **Fixed 2026-10-03** (unit + fake-model loop tests; live confirmation pending LIVE-006) |

---

## 5. Maintenance

When adding/changing/removing any harness feature, setting, nudge, or gate:

1. Update the relevant section(s) above.
2. Re-read **§3** and **§4** for new ordering or collision pairs.
3. Run `npm run typecheck` and `npm test`.

See also `CLAUDE.md` (repo notes) and `PROGRESS.md` (release plan status).
