# Changelog

All notable changes to Forge are logged here. This file exists specifically so
that "did the last release actually fix what it claims to" has a paper trail
you can check against — see the testing notes in the README for how each
entry below was verified.

## 0.8.0

A single explicit request ("next update will be a thorough web search tool, a production grade one... I can't give you requirements, I want you to figure it out") with no requirements attached — every design decision below (which providers, opt-in vs. on-by-default, where credentials live, robots.txt compliance, paging shape) was made without further input and documented as it was made, not retrofitted. Verified with `tsc --noEmit`, `node --check` on the webview JS, and a new runtime test file (`test_v6.ts`, 74 assertions covering HTML extraction, robots.txt parsing, the DuckDuckGo scrape parser, provider fallback/retry/cache/dedupe/domain-filtering with a mocked `fetch`, fetch-service robots-gating/paging/PDF-rejection, the tool wrappers' enabled/disabled/formatting behavior, and a full agentLoop integration round-trip) plus the full existing suite (244 assertions total across all 9 test files, all passing). Writing this test suite caught one real bug before release — see Fixed below. Not yet run inside a real VS Code extension host, and specifically not yet tested against any of the five real provider APIs with a live key — same sandbox caveat as every release so far, see README → Testing, now doubly relevant since this is the first feature that talks to real external services.

### Added

1. **`web_search` and `web_fetch` tools, opt-in via `forge.webSearch.enabled` (default `false`).** This is the first Forge feature that inherently can't honor the "no cloud, no telemetry, everything stays on your machine" claim the rest of the README makes — a search query has to leave your machine, and fetched pages come from third-party servers. Rather than quietly carve out an exception to that promise, it ships disabled, with the reasoning spelled out in the setting's description, the Settings panel, and a new README section ("Web search") rather than buried in a code comment only a developer would read.
2. **Five search providers**, tried in this order under `forge.webSearch.provider: "auto"` (or pin one explicitly): **Tavily** (built for LLM consumption, pre-cleaned results) → **Brave Search** → **Google Programmable Search** (needs both an API key and a Search Engine ID) → **SearXNG** (self-hosted, no third-party key needed at all if you run your own instance — the closest fit to Forge's local-first ethos) → **DuckDuckGo** (no key, no setup, always available — scrapes DuckDuckGo's no-JS HTML results page since there is no public documented DuckDuckGo search API; this makes it the most fragile of the five, used only as the final fallback). Verified each provider's actual current API shape (endpoint, auth header, params) against live documentation rather than assumed from training data — this specifically caught that Tavily's auth moved from a body field to a Bearer header at some point, and confirmed Microsoft retired the Bing Search APIs on August 11, 2025, which is why Bing isn't one of the five.
3. **API keys stored in `vscode.SecretStorage`** (your OS keychain), not `settings.json` — the one deliberate exception to "every Forge setting is a plain, visible `forge.*` value," because credentials are a different kind of thing than a preference. Set via **Forge: Set Web Search API Key** or the new Settings panel section, which shows configured/not-configured status per provider without ever displaying the stored key.
4. **`web_fetch` extracts readable text, not raw HTML** — scripts/styles/nav/header/footer stripped, `<main>`/`<article>` preferred when present, via a hand-written "readability-lite" pipeline (`websearch/htmlExtract.ts`) rather than a real DOM-based parser, since Forge deliberately ships zero runtime npm dependencies and won't pull in cheerio/jsdom/@mozilla/readability for this. Known, disclosed tradeoff: worse than a real readability library on adversarial/unusual markup, fine on normal articles/docs pages.
5. **`web_fetch` respects `robots.txt` by default** (`forge.webSearch.respectRobotsTxt`, default `true`) — a hand-written parser (`websearch/robotsTxt.ts`) supporting per-user-agent groups, `*`/`$` wildcards, longest-match-wins with Allow beating Disallow on a tie, fail-open on a missing/unreachable robots.txt per the spec's own default. A disallowed fetch is refused with a clear explanation rather than silently skipped or silently ignored.
6. **Character-offset paging for `web_fetch`**, mirroring `read_file`'s line-range paging — a long article doesn't blow the context window in one call; the result tells the model exactly how to call again to keep reading.
7. **PDFs and other binary content types are honestly rejected**, not mis-extracted as garbled text — no PDF-parsing dependency is bundled, same zero-dependency reasoning as the HTML extractor.
8. **Retry, fallback, caching, dedup, and domain-blocking**, all in `websearch/searchService.ts`/`fetchService.ts`: a failing provider is retried once before falling through to the next one in the chain; identical queries/pages are served from a short in-memory cache (`forge.webSearch.cacheTtlMinutes`, default 10) so a looping agent turn or repeated question doesn't hammer a provider or burn paid-API quota; results are de-duplicated by normalized URL; `forge.webSearch.blockedDomains` filters out hostnames you never want surfaced.
9. **New Settings panel section** ("Web search") for the toggle, provider, max results, robots.txt toggle, SearXNG URL, and per-provider configured/not-configured status — same `settingRow()` pattern as every other panel section, wired with dedicated (not generically-looped) event listeners since the dotted `webSearch.*` config keys don't fit the existing generic key-to-DOM-id convention cleanly.

### Fixed

- **`web_fetch`'s list-item formatting was silently dead code.** `htmlExtract.ts`'s plain-text conversion ran a generic pass that turned every `<li>`/`</li>` boundary into a bare newline *before* a separate, more specific pass tried to give list items a leading "- " marker — by the time that second pass ran, the `<li>` tags it was looking for no longer existed in the string, so it never matched anything. Caught by `test_v6.ts`'s list-formatting assertion, not by manual testing. Fixed by pulling `li` out of the generic tag-boundary loop entirely and handling its open/close tags explicitly, unconditionally (not dependent on being preceded by a newline, since two adjacent `<li>` elements aren't always whitespace-separated in real markup).

## 0.7.0

A 6-item request: a real bug fix (Outcome mode's autonomy was incomplete), a new delegation primitive (sub-agents), a new settings surface, and three UX rounding-outs (HW metrics, chat rename, brief status messages). Verified with `tsc --noEmit`, `node --check` on the webview JS, and a new runtime test file (`test_v5.ts`, 22 assertions) plus the full existing suite (170 assertions total, all passing). Not yet run inside a real VS Code extension host — same caveat as every release so far, see README → Testing.

### Fixed

- **Outcome mode was silently still requiring approvals.** Outcome mode's system prompt (added in 0.5.0) claims full autonomy "same as Auto mode," but the actual approval-gating code — `agentLoop.ts`'s `autoMode` flag and `chatSession.ts`'s `ApprovalBroker` wiring — only ever checked `mode === 'auto'`, never `'outcome'`. So every Outcome-mode edit and command has been quietly waiting on an approval click this whole time, contradicting the mode's own description. Fixed with a new `isAutonomousMode(mode)` helper in `modes.ts` (true for `auto`/`outcome`) used at both gate sites instead of the `'auto'`-only check. Auto and Outcome remain two separate modes with their own prompts/labels/UI — this only fixes the capability gap between what Outcome mode claimed and what it actually did. A new runtime test (`test_v5.ts`) exercises this end-to-end: an Outcome-mode `write_file` call is now asserted to land on disk immediately, not just described in a prompt string.

### Added

1. **Sub-agents (`spawn_subagent` tool)** — the agent can delegate a self-contained sub-task to a nested, fully autonomous agent turn and get back a summary, instead of doing everything inline in one long tool-call chain. Implemented as a closure inside `runAgentTurn` that recursively calls itself (mode always `auto`, so no approval prompts), sharing the same cancellation token as the parent so a Stop click also stops any in-flight sub-agent. Nesting is capped (`forge.maxSubAgentDepth`, default 2, hard-ceilinged at 4 regardless of the setting) so a sub-agent can't spawn an unbounded tree of sub-agents. Only the sub-agent's final answer (or error/abort) is folded back into the parent's transcript, shown as its own card in the chat — its own step-by-step tool trace doesn't flood the parent conversation. New settings: `forge.subAgentModel` (which model runs sub-agent turns; blank reuses the parent's), `forge.subAgentMaxIterations` (its own tighter step budget than `forge.autoModeMaxIterations`).
2. **Expanded HW metrics** — the composer footer's HW readout now also shows context-window usage (last call's prompt+eval tokens vs. the active chat's configured ceiling), system RAM (`os.totalmem()`/`freemem()`, always available), and best-effort GPU utilization/VRAM via `nvidia-smi` (silently omitted on non-NVIDIA machines — Apple Silicon, AMD, no discrete GPU — which is the common case for a local-Ollama laptop setup, not an error). New `src/util/hwMetrics.ts`.
3. **Per-chat context-window override** — a chat pinned to a light/fast model can afford a bigger context window than the global default (`forge.numCtx`) since it leaves more memory/VRAM headroom than a bigger model would; set per-chat from the new Settings panel. Threaded through as `AgentTurnOptions.numCtx`, defaulting to the global setting when unset. Also applies to any sub-agents that chat spawns.
4. **Settings panel** — a new gear-icon panel in the chat header for tweaking settings without leaving the chat view or hand-editing `settings.json`: the per-chat context override above, global context window/temperature/keep-alive/approval toggles, the "show brief status messages" toggle below, and the sub-agent model/step-budget/nesting-depth settings. Backed by a small allowlisted `setForgeSetting()` writer (`util/config.ts`'s `SETTINGS_PANEL_KEYS`) so a webview message can only ever touch the specific settings the panel exposes, not arbitrary VS Code configuration.
5. **Chat rename** — double-click a tab title, or use the ✎ icon in the All Chats panel, to rename a chat. Uses the same in-DOM `textPromptDialog()` pattern as 0.6.0's confirm-dialog fix rather than `window.prompt()`, which has the identical VS Code webview reliability problem as `window.confirm()`. A renamed chat's title is marked `titleManuallySet` so the first-message auto-title logic never silently overwrites it again.
6. **Brief agent-activity status messages** — a new `AgentEvent` type (`status`) emits short, human-readable lines ("Thinking with qwen2.5-coder:14b…", "Reading src/foo.ts…", "Running `npm test`…", "Delegating to a sub-agent: …") shown in the composer footer while the agent works, so it's clear what's happening during a long autonomous run without reading the full tool-call trace. Toggleable via the new `forge.showStatusMessages` setting.

## 0.6.0

Two bug reports from actually using this in a real VS Code window for the first time (everything before this was type-checked and unit-tested in a sandbox that can't run the real extension host — see README → Testing).

### Fixed

- **Root cause of "chats can't be deleted or closed" (and very likely part of "Auto mode doesn't work"): `window.confirm()`/`alert()` are not reliably supported inside a VS Code webview.** This is a documented webview limitation, not something obvious from the code — every confirmation dialog in the chat panel (closing a tab, switching to Auto/Outcome mode, restoring a checkpoint) used `window.confirm()`, which can silently no-op in a real webview instead of showing anything, which looks exactly like "I clicked the button and nothing happened." Replaced with a real in-DOM modal (`confirmDialog()` in `webview.js`) that behaves the same way every time. Also added a global `window.onerror`/`unhandledrejection` handler that surfaces any future webview JS error as a toast instead of failing silently, so the next "nothing happened" bug is diagnosable instead of invisible.
- Mode switches now show a confirmation toast ("Switched to Auto mode.") so it's visible whether a switch actually landed — useful for exactly this kind of "did that even work" question going forward.

### Changed

- **Closing a chat tab no longer deletes it — it archives it.** This was flagged directly ("chats can't be closed... I want chats to be saved locally"): the × button used to permanently delete `.forge/chat/<id>.json` with no way back (by design, since 0.2.1). Now it just hides the chat from the open-tabs strip; the session file stays on disk untouched. A new **All Chats** panel (📁 in the header, next to search) lists every chat, open or closed — click a title to reopen it (clears the closed flag), or the 🗑 to actually delete it for good, which now requires a separate, deliberate, still-confirmed action instead of being what closing did. `ChatStore` gained `SessionSummary.closed` and `setClosed()`; `save()` was fixed to preserve the closed flag across a resave, so a background turn completing on an archived chat can't silently reopen it.

Verified with `tsc --noEmit`, `node --check` on the webview JS, and 8 new `test_chatstore.ts` assertions covering the close/reopen/resave-preserves-closed contract, plus the full existing suite (all passing). The confirm-modal and webview-error-handler fix specifically targets something the sandbox here cannot reproduce or verify (real webview behavior) — this is a best-effort fix based on a well-documented VS Code webview limitation, not something confirmed against your actual report. Please retest both — especially Auto mode — and report back if either is still broken; if Auto mode still doesn't work after this, it's a different bug and I'll need the exact symptom (error toast text, or what you see in Developer: Open Webview Developer Tools) to keep digging.

## 0.5.0

Four of the five improvements from the last roadmap review, folding "Auto mode definition of done" into the headline item below since they turned out to be the same mechanism. The headline one is genuinely new behavior rather than a refinement: a mode where you state a destination and Forge works backward from it instead of you writing the steps. Verified with `tsc --noEmit` and a new runtime test file (`test_v4.ts`, 23 assertions) that exercises the actual iterate-until-true loop end-to-end — not just its pieces — plus the full existing suite (all still passing). Not yet run inside a real VS Code extension host, same caveat as every release so far.

### Added

1. **Outcome mode ("reverse engineering")** — a 5th mode. Your message is treated as a goal (an end state), not a to-do list: the system prompt has the model restate it as concrete checkable criteria, investigate the current state, and work backward to close the gap, fully autonomously (same no-approval behavior as Auto mode, same dangerous-command denylist exception, a checkpoint saved before every turn). The part that makes "keep iterating until it's actually true" real rather than just a prompt asking the model to be honest: an optional **definition-of-done command** (composer footer, shown for Agent/Auto/Outcome). If set, a plain-text "I'm done" answer is not accepted at face value — Forge runs the command itself, and only a genuine exit-0 ends the turn. A failing check gets fed straight back as evidence and the model gets another attempt, safety-netted by the existing loop detector so an unpassable check still stops instead of burning the whole iteration budget. Works in Agent and Auto mode too, not just Outcome — this is also the "Auto mode definition of done" item from the last roadmap review, generalized rather than built twice.
2. **Multi-model task routing** — `forge.modelRouting` maps mode → model (e.g. a reasoning-tuned model for Plan, a strong coder for Agent/Auto/Outcome, reuse the default for Ask). **Forge: Set Model for Mode** is a quick-pick UI for it, no JSON editing required. Resolution order: a chat tab's own model override, then per-mode routing, then `forge.chatModel`.
3. **Automatic memory extraction** — the existing `remember` tool only ever fires when the model thinks to call it mid-conversation; this adds a periodic review pass (every 6 completed turns per chat, always fire-and-forget so it can never slow a turn down) that re-reads the recent transcript and proposes durable facts on its own. Every proposed fact still goes through `MemoryStore.addFact()`'s de-dupe, so an over-eager review pass can only ever add a fact once.
4. **Faster chat search** — `ChatViewProvider` now caches each closed session's transcript keyed by its `updatedAt`, so repeated searches (e.g. typing a query character by character) stop re-reading and re-parsing every session's JSON file from disk on every keystroke; a session only gets re-read when it's actually changed.

## 0.4.0

The context-window discussion from 0.3.0's compaction work led directly here: compaction keeps one long *turn* from blowing the context window, but it doesn't help a *project* that outlives any single chat — a fresh chat still starts from nothing, and a long chat's compacted-away detail is only ever recoverable by scrolling. This release adds a retrieval-based memory system to actually fix that, instead of just bounding it. Verified with `tsc --noEmit` and a new runtime test file (`_devtools/runtime_test/test_memory.ts`, 22 assertions covering both the embeddings path and the keyword-fallback path) plus the full existing suite (all passing); not yet run inside a real VS Code extension host — same caveat as every release so far, see README → Testing.

### Added

- **`.forge/memory.md` — durable, curated facts.** A short plain-text file (one fact per line) injected into every system prompt, the same way `.forge/rules/` is. The agent adds to it itself via a new `remember` tool (case-insensitive de-duped, capped per-fact length) when it learns something worth never forgetting — a convention, a decision and why, a preference. **Forge: Open Memory File** opens/creates it for hand-editing. Rendering into the prompt is capped (~4000 chars, keeping the *most recent* facts) so even a neglected, overgrown memory file can't itself blow the context budget it exists to protect.
- **`search_chat_history` — semantic search over every past chat.** A new `ChatMemoryIndex` mirrors the existing `@codebase`/`search_codebase` machinery (`WorkspaceIndex`): chunks `.forge/chat/*.json` transcripts, embeds them with the configured embedding model, cosine-ranks results, and falls back to keyword search automatically if no embedding model is installed. Indexing is incremental and per-session — a content-hash gate means re-indexing after a turn only re-embeds the session that actually changed, not the whole chat history, so this stays cheap even in a long-running project with many past chats. The agent is nudged (system prompt) to call this instead of asking you to repeat something that sounds like it was already discussed.
- Both new tools (`remember`, `search_chat_history`) are available in Ask mode too, not just Agent/Auto — neither has a side effect Ask mode's read-only guarantee needs to gate (`remember` only ever touches `.forge/memory.md`, not your code; the other is pure read).
- `src/util/vector.ts` — `cosineSimilarity` extracted out of `workspaceIndex.ts` so `ChatMemoryIndex` doesn't duplicate it; `workspaceIndex.ts` refactored to import it, no behavior change.

## 0.3.0

Two things landed together in this release: your local hand-edits to the *installed* extension (documented in `forgechanges20260815.md`) ported into the actual TypeScript source so they survive a rebuild, plus ten requested additions. Everything below was verified with `tsc --noEmit` and targeted runtime tests (`_devtools/runtime_test/` — `test_v3.ts` and additions to `test_edit.ts`/`test_chatstore.ts`, all passing); none of it has been run inside a real VS Code extension host (see README → Testing for why that gap still exists in this sandbox). Treat this release with the same "read the diff, run the manual QA checklist" posture as any other, more so given its size.

### Ported from your local edits (now in source, not just the installed build)

- **`num_ctx` and `keep_alive` are now sent on every Ollama call** (chat, inline edit, Tab completion) — configurable via new settings `forge.numCtx` (default `32768`, not your local `262144`; see below) and `forge.keepAliveMinutes` (default `-1`, matching what you found actually works regardless of how `Ollama.app` launches its `ollama serve` subprocess).
- **Context pruning and compaction**, redesigned rather than copied verbatim — see "Context trimming" below for why.
- **The `search_codebase`/`search_code`-over-`read_file` system prompt nudge** — ported as-is.
- **`maxAgentIterations`** raised, but not to a literal `10000000` — see "Fully autonomous mode" below for why a different number and a different mechanism.

**Why `forge.numCtx` defaults to `32768`, not your `262144`:** your number was correctly derived for your machine (Mac Studio, 128GB unified memory) and is exactly right for you — set it in Settings and it'll behave identically to your local hack. But this is a setting shipped in source now, not a value baked in for one machine, and `32768` is a safer default for anyone else (or future-you on a different machine) who hasn't done that hardware analysis. Same reasoning applies nowhere else in this list; this is the one place your exact number wasn't carried forward as the default.

### Added

1. **HW utilization metrics** — live tokens/sec in the composer footer after each response, plus currently-loaded models and their VRAM footprint (via Ollama's `/api/ps`), refreshed automatically and on click. Also `Forge: Show HW Utilization` command.
2. **Auto mode** — fully autonomous: no approval prompts for edits or commands (a small hard-coded dangerous-command denylist is the one exception, and it applies regardless of mode). On a tool failure it's instructed to diagnose and try something else rather than stop and ask. Backed by checkpoints (#3) and the loop detector (#7) as its real safety net, replacing the old "stop after 25 steps" net that a fully-autonomous mode can't rely on.
3. **Checkpoints** — every user message is a checkpoint; restoring one reverts every file touched since and truncates the chat back to that point, together, so files and transcript never drift apart. Plus an append-only crash-recovery log (`.forge/chat/<id>.log.jsonl`) so a crash or a fresh session can see the last few tool calls/decisions even if the last full snapshot is slightly stale.
4. **Context trimming without information loss** — pruning/compaction now operate on a *view* built fresh for each model call, never on the archival transcript that gets persisted. The full conversation is always still in `.forge/chat/<id>.json`; only what's sent to Ollama on a given turn is bounded. This is a deliberate redesign from how the local hack worked (see the ported-changes note above) — that version compacted the same array that got saved as permanent history, which is exactly the "don't lose my information" problem being asked about here.
5. **Folders (not just files) can be `@`-tagged**, and the mention dropdown (for both `@` files/folders and `/` skills) now supports **arrow-key navigation** (↑/↓ to move, Enter/Tab to pick), not just the mouse.
6. **Search across every chat** — 🔍 in the header, searches every saved session's transcript, not just the open tab.
7. **Loop detector** — watches every tool call's outcome; if the same action repeats 3× in a row, or 4× within the last 8 steps, the turn stops with an explanation instead of continuing to burn iterations. This is what makes the higher iteration caps (below) and Auto mode's total lack of approvals safe.
8. **Fixed: Stop button showing "Could not reach Ollama" instead of just stopping.** Root cause: cancelling the in-flight request throws a plain `AbortError`, which `OllamaClient` was unconditionally rewrapping into "Could not reach Ollama at ... Is it running?" — true for a real connectivity failure, misleading for a user-initiated Stop. Fixed in `ollama/client.ts` (chat/generate) and the same pattern in the Cmd+K inline-edit flow, which had the identical bug.
9. **Clickable file references** — a tool card's path, and any backtick-quoted path in an assistant message that looks like a file (e.g. `` `src/foo.ts` ``), opens that file on click.
10. **Fixed (mitigated): hallucinated "I created/updated that file" claims.** Final answers are now scanned for change-verb + backtick-path claims ("created `foo.ts`") with no matching `write_file` call anywhere in the conversation; if found, the agent gets up to two nudges to actually make the change or correct its claim before the answer ships. If it still ships with an unverified claim, the UI shows a visible warning on that message rather than presenting it as fact. This is a mitigation (a regex-based check), not a guarantee — see README → Known limitations.

### Also changed

- `forge.maxAgentIterations` default raised `25` → `200` (Agent/Ask/Plan); a new `forge.autoModeMaxIterations` (default `100000`) covers Auto mode. The loop detector (#7), not a low iteration count, is now the actual thrash-safety-net — see the ported-changes note above for why this isn't literally unbounded.
- `ChatStore.save()` now writes to a temp file and renames over the target instead of writing the target path directly, so a mid-write crash can't leave a corrupted, half-written session file behind.
- `ChatViewProvider`'s file-mention search now also returns folders and is shared through a new `WorkspaceEntryIndex` util instead of being duplicated between `chatViewProvider.ts` and a dead, never-called copy in `chatSession.ts` (removed).

## 0.2.1

### Fixed

- **Closed chats reappeared in the tab strip ("chats don't delete").**
  `closeSession` only removed the session from the in-memory `Map` that
  backs the open tabs; it never called `ChatStore.delete()`. Every list
  refresh (`pushSessionsList()`, and the equivalent logic in `sendInit()`)
  rebuilt its tab list from `ChatStore.listSessions()`, which reads
  `.forge/chat/index.json` straight off disk — so a session that had ever
  been saved (i.e. had at least one message) came right back the moment
  anything else changed. `ChatStore.delete()` existed and worked correctly;
  it just wasn't wired to the close button.

  Fix: closing a tab now deletes that chat's persisted history too — the ×
  button asks for confirmation ("Delete this chat permanently") and, once
  confirmed, removes both the in-memory session and its `.forge/chat/<id>.json`
  file / index entry. There's intentionally no separate "hide but keep"
  state yet (see Known limitations below); Forge always keeps at least one
  chat alive, so you can't delete your only open conversation.

  Files touched: `src/chat/chatViewProvider.ts` (`closeSession` handler),
  `media/webview.js` (confirmation prompt + updated tooltip), `README.md`
  (corrected the multitask section, which previously described behavior
  that didn't match the code).

### Known limitations carried into this release

- No "archive"/"hide" option distinct from permanent delete — that's a
  reasonable v3 addition (a separate history browser backed by
  `ChatStore.listSessions()` that isn't conflated with the open-tabs strip)
  but out of scope for this bugfix.
- This fix has TypeScript-level verification (`npm run typecheck` passes)
  and was traced by hand against the exact code path, but has **not** been
  run inside a real VS Code extension host — see README → Testing for why,
  and what to run on your machine before you trust it in your main repo.

## 0.2.0

Initial v2 release: Agent/Ask/Plan modes, multitask chat tabs, repo-stored
chat history (`.forge/chat/`), `.forge/rules`, `.forge/skills`,
`.forge/hooks`. See `CURSOR_PARITY.md` for the full feature catalogue this
release was built against.
