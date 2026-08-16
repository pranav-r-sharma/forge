# Forge roadmap — what's next

Everything here is catalogued but not built. Ordered roughly by how much day-to-day value it'd add for a solo developer versus how much it costs to build well.

**Shipped in 0.3.0** (used to be listed here as #1/#2 plus several items under "Everything else"): Auto mode (fully autonomous, no approvals, loop-detector-backed), checkpoints (restore a chat + its files to any earlier message), context pruning/compaction that never touches the persisted transcript, a crash-recovery append log, cross-chat search, folder-aware `@`-mentions with arrow-key navigation, clickable file references in the transcript, HW utilization (tokens/sec, loaded-model VRAM via `/api/ps`), and the `num_ctx`/`keep_alive` tuning + stop-button-error-message fix that were ported in from local hand-edits. See `CHANGELOG.md` for the full list and what was actually verified vs. just type-checked.

## 1. Multi-model task routing

Right now Forge has two model slots: `forge.chatModel` (agent/chat) and `forge.completionModel` (Tab). The natural next step is routing by *task type*, not just chat-vs-completion, because local models have real, different strengths and a single model is a compromise for everything:

- A fast small model (1.5B–3B) for Tab autocomplete and quick Ask-mode questions.
- A strong reasoning/coding model (14B–32B class) for Agent/Auto mode's actual editing work.
- A dedicated model for Plan mode — arguably wants more "thinking," less "doing," so a model tuned for reasoning over raw code generation could plan better than the model you'd pick for Agent mode.
- The embedding model for `@codebase`, already separate.

Concretely, this looks like: a `forge.modelRouting` setting (or a small "Models" panel) mapping `{agent, ask, plan, auto, completion, embedding}` → model tag, each independently pickable via the existing quick-pick UI. `ChatSession` already carries a per-session `model` override and `runAgentTurn` already takes an explicit `model` argument, and modes are already first-class (`ForgeMode`) — so the plumbing is mostly there; this is really "resolve model by mode instead of one global `chatModel`" plus the settings UI to configure it. A stretch version: let a *cheap* model act as a router that reads the user's message and picks which model/mode handles it — probably overkill for a local single-user tool where you already know what you want.

This is now the single biggest item left on the list.

## 2. Everything else, grouped

**Context & indexing**
- `@`-mention a specific symbol/function, not just a whole file/folder (needs a lightweight per-language symbol index — VS Code's own `DocumentSymbolProvider` API can supply this for free for any language with a symbol provider installed).
- Auto-index on workspace open + incremental re-index on save, instead of the manual **Forge: Index Workspace** command.
- `.forgeignore` (mirrors `.gitignore` syntax) to control what the indexer and file tools ever see, beyond the current fixed ignore list.
- `@docs` — point Forge at a doc site URL, fetch + chunk + embed it alongside the codebase index.
- `@web` — a `web_search` tool, useful for "what's the current API for X library" style questions; needs a local-friendly search backend (e.g. a user-supplied SearX instance or API key) since there's no built-in web index to call.
- A real index (not a linear scan) behind chat search, if the number/length of saved chats grows enough for the current approach to feel slow.

**Editing & review**
- Auto-invoke `get_problems` right after an accepted edit and feed diagnostics back to the agent automatically, instead of relying on it to remember to check.
- Cursor-style "jump to next suggested edit" for Tab (multi-file-aware prediction) — a bigger lift, lower priority.
- Cross-tab checkpoint awareness, so restoring one multitask tab's checkpoint doesn't silently clobber a later edit made by another tab to the same file (currently an documented limitation, see README).

**Customization**
- User-level (global, cross-project) rules, not just project-scoped `.forge/rules/`.
- An MCP client, so Forge's agent can call the same MCP tool servers Claude/Cursor use (filesystem, GitHub, databases, etc.) instead of only its own built-in tool set. Highest-effort item on this list, also highest ceiling — turns Forge from "has 7 tools" into "has whatever tools you connect."
- Memories: let the agent propose durable facts about the project/your preferences ("this repo uses pnpm, not npm") and save them into a rule file with one click, rather than you writing rules by hand every time.

**Environment**
- Long-running/background terminal processes the agent can start and later check on (e.g. "start the dev server" then keep coding), instead of every `run_command` call being run-to-completion-or-timeout.
- An explicit "definition of done" for Auto mode (a command that should exit 0, e.g. `npm test`) that it re-runs automatically after each attempt, rather than relying on it to decide for itself when it's finished — Auto mode today is "keep going without asking," not yet "keep going until this specific check passes."

Have opinions on the ordering, or want one of these scoped into an actual build? Say the word and I'll pick it up the same way — catalogue the exact behavior first, then build it.
