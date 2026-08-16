# Changelog

All notable changes to Forge are logged here. This file exists specifically so
that "did the last release actually fix what it claims to" has a paper trail
you can check against — see the testing notes in the README for how each
entry below was verified.

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
