# Changelog

All notable changes to Forge are logged here. This file exists specifically so
that "did the last release actually fix what it claims to" has a paper trail
you can check against — see the testing notes in the README for how each
entry below was verified.

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
