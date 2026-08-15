# Changelog

All notable changes to Forge are logged here. This file exists specifically so
that "did the last release actually fix what it claims to" has a paper trail
you can check against — see the testing notes in the README for how each
entry below was verified.

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
