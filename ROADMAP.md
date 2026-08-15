# Forge roadmap — what's next

Everything here is catalogued but not built. Ordered roughly by how much day-to-day value it'd add for a solo developer versus how much it costs to build well. The first two are your own suggestions and are the biggest lever available — everything else is smaller and more incremental.

## 1. Multi-model task routing

Right now Forge has two model slots: `forge.chatModel` (agent/chat) and `forge.completionModel` (Tab). The natural next step is routing by *task type*, not just chat-vs-completion, because local models have real, different strengths and a single model is a compromise for everything:

- A fast small model (1.5B–3B) for Tab autocomplete and quick Ask-mode questions.
- A strong reasoning/coding model (14B–32B class) for Agent mode's actual editing work.
- A dedicated model for Plan mode — arguably wants more "thinking," less "doing," so a model tuned for reasoning over raw code generation could plan better than the model you'd pick for Agent mode.
- The embedding model for `@codebase`, already separate.

Concretely, this looks like: a `forge.modelRouting` setting (or a small "Models" panel) mapping `{agent, ask, plan, completion, embedding}` → model tag, each independently pickable via the existing quick-pick UI. `ChatSession` already carries a per-session `model` override and `runAgentTurn` already takes an explicit `model` argument, and modes are already first-class (`ForgeMode`) — so the plumbing is mostly there; this is really "resolve model by mode instead of one global `chatModel`" plus the settings UI to configure it. A stretch version: let a *cheap* model act as a router that reads the user's message and picks which model/mode handles it, mirroring how some multi-model products auto-select — probably overkill for a local single-user tool where you already know what you want.

## 2. Full autonomous "run until it works" loop

Today, Agent mode iterates up to `forge.maxAgentIterations` steps *within a single message*, then stops and waits for you to send the next message. What you're asking for is closer to: describe a task once, and the agent keeps working — including re-running tests/builds and reacting to failures — across many rounds without you re-prompting it, until it either succeeds or genuinely gets stuck.

Design sketch for a new **Auto mode** (alongside Agent/Ask/Plan):

- You give it a task plus a *definition of done* — explicitly (a command that should exit 0, e.g. `npm test`) or implicitly (Forge infers a sensible check: run the project's test script if one exists, else `get_problems` across the workspace for zero errors).
- The loop: run a normal Agent turn → when it produces a final answer claiming completion, automatically run the done-check command → if it passes, stop and report success; if it fails, feed the failure output back in as a new user turn ("the check failed with: ...; fix it and try again") and keep going — without requiring you to click Send again.
- Hard guardrails, since this removes the natural per-message pause: a much larger overall iteration/time budget than `maxAgentIterations` (its own setting), a visible "stop" control that's always one click away, and — importantly — this mode should probably still route file writes through the existing approval/pending-edit review rather than silently auto-applying everything, unless the user explicitly opts into full auto-apply for the run. Command approval likewise still applies unless the done-check command itself is pre-approved.
- Failure mode to design for explicitly: thrashing (repeating the same failing fix). Track a rolling hash of the last N attempted diffs/commands and if the same failure + same fix recurs, stop and ask rather than loop forever burning tokens.

This is the single highest-value addition for "hands-off" workflows and is a natural extension of the mode system just shipped, not a rewrite.

## 3. Everything else, grouped

**Context & indexing**
- `@`-mention a specific symbol/function, not just a whole file (needs a lightweight per-language symbol index — VS Code's own `DocumentSymbolProvider` API can supply this for free for any language with a symbol provider installed, so this is cheaper than it sounds).
- Auto-index on workspace open + incremental re-index on save, instead of the manual **Forge: Index Workspace** command.
- `.forgeignore` (mirrors `.gitignore` syntax) to control what the indexer and file tools ever see, beyond the current fixed ignore list.
- `@docs` — point Forge at a doc site URL, fetch + chunk + embed it alongside the codebase index.
- `@web` — a `web_search` tool, useful for "what's the current API for X library" style questions; needs a local-friendly search backend (e.g. a user-supplied SearX instance or API key) since there's no built-in web index to call.

**Editing & review**
- Checkpoints: snapshot the working tree (or just the set of accepted edits) at each user message so you can revert the whole conversation-so-far in one click, not just file-by-file.
- Auto-invoke `get_problems` right after an accepted edit and feed diagnostics back to the agent automatically, instead of relying on it to remember to check.
- Cursor-style "jump to next suggested edit" for Tab (multi-file-aware prediction) — a bigger lift, lower priority.

**Customization**
- User-level (global, cross-project) rules, not just project-scoped `.forge/rules/`.
- An MCP client, so Forge's agent can call the same MCP tool servers Claude/Cursor use (filesystem, GitHub, databases, etc.) instead of only its own built-in tool set. Highest-effort item on this list, also highest ceiling — turns Forge from "has 7 tools" into "has whatever tools you connect."
- Memories: let the agent propose durable facts about the project/your preferences ("this repo uses pnpm, not npm") and save them into a rule file with one click, rather than you writing rules by hand every time.

**Environment**
- Long-running/background terminal processes the agent can start and later check on (e.g. "start the dev server" then keep coding), instead of every `run_command` call being run-to-completion-or-timeout.
- Conversation summarization when a session's context gets long, so multi-hour sessions don't degrade as they approach the model's context window.

Have opinions on the ordering, or want one of these scoped into an actual build (like v2 was)? Say the word and I'll pick it up the same way — catalogue the exact behavior first, then build it.
