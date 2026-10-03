# Knowledge base (append-only)

Lessons, pitfalls and rejected approaches. Never delete entries. Each cites its evidence.

## 2026-10-03

- **Context meter read ~2% with a warm cache.** Root cause: it summed `promptTokens`, which means tokens EVALUATED (cached prefix excluded), plus reply tokens. Evidence: trace `_devtools/e2e/results/suite1-t05-large-file-new-r2.trace.jsonl` last row: promptTokens 96, cachedTokens 5131. Fix: `src/util/contextUsage.ts`. Lesson: on any runtime with a prompt cache, "prompt size" must be total (evaluated + cached).
- **Abrupt stops.** Root cause: any reply with no tool call was accepted as the final answer. An empty reply, or one whose last sentence only promised an action, ended the turn. Fix: `classifyStalledReply` + nudge (cap 2). Not yet confirmed live (LIVE-006). The old traces showed no clean example of it, so the cause is from code reading, not reproduction.
- **ripgrep returns paths relative to the spawn cwd.** The grep upgrade treated them as absolute, so results for a `path`-scoped search came back as `../../../..` junk. The author's tests used only the JS engine for that case. Lesson: every behavior test must also run on the rg engine (parity tests now do).
- **Cursor `--model grok-4.7-high` can fail with "Connection stalled repeatedly"** and change nothing. It is transient; a plain retry worked. Evidence: `logs/AGENT_USAGE.md`.
- **Auto mode classifier blocks edits to the global rules file** (`~/.claude/rules/agent-bridge.md`) as self-modification until the owner approves explicitly.
- Rejected: a second, separate `grep` tool next to `search_code` (more tools for the model to choose between). Chosen: upgrade `search_code` in place.
- Rejected: a local HTTP server + CLI for the Cursor link, and a fully headless Forge. Owner chose the file mailbox (simpler; VS Code must stay open).
