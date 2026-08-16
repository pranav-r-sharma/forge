# Forge roadmap — what's next

Everything here is catalogued but not built. Ordered roughly by how much day-to-day value it'd add for a solo developer versus how much it costs to build well.

**Shipped in 0.3.0** (used to be listed here as #1/#2 plus several items under "Everything else"): Auto mode (fully autonomous, no approvals, loop-detector-backed), checkpoints (restore a chat + its files to any earlier message), context pruning/compaction that never touches the persisted transcript, a crash-recovery append log, cross-chat search, folder-aware `@`-mentions with arrow-key navigation, clickable file references in the transcript, HW utilization (tokens/sec, loaded-model VRAM via `/api/ps`), and the `num_ctx`/`keep_alive` tuning + stop-button-error-message fix that were ported in from local hand-edits. See `CHANGELOG.md` for the full list and what was actually verified vs. just type-checked.

**Shipped in 0.4.0**: the memory system — `.forge/memory.md` (durable, curated, agent-maintainable facts injected into every prompt) and `search_chat_history` (semantic search over every past chat, mirroring `@codebase`'s embedding-index approach). This is what used to be listed under "Customization" below as "Memories"; it's now built, not catalogued. See `CHANGELOG.md` for the full entry.

**Shipped in 0.5.0**: Outcome mode ("reverse engineering" — state a destination, Forge works backward from it) with an optional definition-of-done command that gates whether a "done" claim is actually accepted, multi-model task routing (`forge.modelRouting` + **Forge: Set Model for Mode**), automatic periodic memory extraction (not just the model-initiated `remember` call), and a search-history cache that stops re-reading every closed chat from disk on every keystroke. See `CHANGELOG.md` for the full entry.

## 1. Everything else, grouped

**Context & indexing**
- `@`-mention a specific symbol/function, not just a whole file/folder (needs a lightweight per-language symbol index — VS Code's own `DocumentSymbolProvider` API can supply this for free for any language with a symbol provider installed).
- Auto-index on workspace open + incremental re-index on save, instead of the manual **Forge: Index Workspace** command.
- `.forgeignore` (mirrors `.gitignore` syntax) to control what the indexer and file tools ever see, beyond the current fixed ignore list.
- `@docs` — point Forge at a doc site URL, fetch + chunk + embed it alongside the codebase index.
- `@web` — a `web_search` tool, useful for "what's the current API for X library" style questions; needs a local-friendly search backend (e.g. a user-supplied SearX instance or API key) since there's no built-in web index to call.
- Chat search's per-session substring scan is now cached (0.5.0), but it's still a linear scan across messages within a session and across all sessions' summaries — a real inverted index would help if the number of saved chats grows very large.

**Editing & review**
- Auto-invoke `get_problems` right after an accepted edit and feed diagnostics back to the agent automatically, instead of relying on it to remember to check.
- Cursor-style "jump to next suggested edit" for Tab (multi-file-aware prediction) — a bigger lift, lower priority.
- Cross-tab checkpoint awareness, so restoring one multitask tab's checkpoint doesn't silently clobber a later edit made by another tab to the same file (currently an documented limitation, see README).

**Customization**
- User-level (global, cross-project) rules, not just project-scoped `.forge/rules/`.
- An MCP client, so Forge's agent can call the same MCP tool servers Claude/Cursor use (filesystem, GitHub, databases, etc.) instead of only its own built-in tool set. Highest-effort item on this list, also highest ceiling — turns Forge from "has 7 tools" into "has whatever tools you connect."
- ~~Memories~~ — shipped in 0.4.0 as `.forge/memory.md` + the `remember` tool. Possible follow-up: a one-click "promote to rule" action for a memory fact that's really a coding convention and belongs in `.forge/rules/` instead.

**Environment**
- Long-running/background terminal processes the agent can start and later check on (e.g. "start the dev server" then keep coding), instead of every `run_command` call being run-to-completion-or-timeout.
- ~~An explicit "definition of done"~~ — shipped in 0.5.0 as the optional verify command in Agent/Auto/Outcome modes. Possible follow-up: multiple check commands (e.g. lint AND test) rather than one.
- Outcome mode's self-verification when no command is configured relies entirely on the model re-checking its own work — a lighter-weight structured self-check (e.g. auto-run `get_problems` before any no-command "done" claim) would make that path more trustworthy without requiring the user to write a shell command.

Have opinions on the ordering, or want one of these scoped into an actual build? Say the word and I'll pick it up the same way — catalogue the exact behavior first, then build it.
