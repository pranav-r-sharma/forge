# Cursor agentic-IDE feature catalogue → Forge parity map

This catalogues Cursor's agentic integration into the editor — everything beyond "it's a chatbot in a sidebar" — and maps each piece to Forge's status. Status legend:

- ✅ **v1** — already shipped in the first drop
- 🆕 **v2** — added in this pass
- 🗺️ **roadmap** — cataloged, not built yet (see `ROADMAP.md` for prioritization)
- ➖ **N/A locally** — depends on Cursor's hosted cloud infrastructure; no faithful local equivalent, noted with a local-first alternative where one exists

## 1. Modes

| Cursor feature | What it does | Forge status |
|---|---|---|
| Ask mode | Read-only Q&A over the codebase, no edits/commands | 🆕 v2 — `ask` mode, tool access limited to read/search |
| Agent mode | Full autonomous tool use: read, write, run commands, iterate | ✅ v1 (was the only mode) → now one of four |
| Plan mode | Model drafts a step-by-step plan first; you approve before it touches anything | 🆕 v2 — `plan` mode: no tools available, produces a checklist, "Execute Plan" hands off to Agent mode |
| (No direct Cursor equivalent — closest is "YOLO mode" auto-run) | Fully autonomous, zero approval prompts | 🆕 v3.0 — `auto` mode, backed by checkpoints + a loop detector as the safety net in place of per-step approval |
| (No direct Cursor equivalent) | State a goal/end-state, not steps — the agent works backward and verifies its own progress | 🆕 v0.5.0 — `outcome` mode ("reverse engineering"): system prompt frames the message as a goal to restate as checkable criteria and close the gap toward, fully autonomous like Auto mode, plus an optional "definition of done" shell command (also usable in Agent/Auto) that Forge itself runs after every claimed-done answer — a failing check is fed back as evidence and the turn keeps going instead of ending on an unverified claim |
| Custom modes (user-defined tool/model presets) | Save a named mode with its own system prompt, tool allowlist, model | 🗺️ roadmap |
| Multitask (parallel agent runs) | Several agent conversations progressing at once, e.g. across worktrees | 🆕 v2 (partial) — multiple chat **tabs/sessions** in one workspace, each with independent history/mode/model, running concurrently. 🆕 v0.7.0: within a single turn, the agent can also delegate self-contained sub-tasks to nested **sub-agents** (`spawn_subagent`, depth-capped, fully autonomous, reports a summary back) — a different axis of parallelism-in-spirit than separate chat tabs. True parallel *worktree* isolation is still roadmap. |
| Background Agent (cloud sandbox, PR creation, Slack trigger) | Kicks off a remote agent run outside your editor | ➖ N/A locally — no cloud sandbox by design. Roadmap alternative: a local "detached run" that keeps iterating in a background terminal while you do something else. |

## 2. Context & @-mentions

| Cursor feature | Forge status |
|---|---|
| @Files / @Folders | ✅ v1 — `@` mention autocomplete attaches file contents |
| @Code (symbol) | 🗺️ roadmap — currently file-level only |
| @Codebase (semantic search over the whole repo) | ✅ v1 — `search_codebase` tool + embedding index, keyword fallback |
| @Docs (indexed external doc sites) | 🗺️ roadmap |
| @Web | 🆕 v0.8.0 — `web_search` + `web_fetch` tools (opt-in, `forge.webSearch.enabled`, off by default since this is the one Forge feature that reaches the open internet). Five providers with `auto` fallback (Tavily/Brave/Google/SearXNG/DuckDuckGo), robots.txt-respecting fetch with readable-text extraction and paging. Not a manual @-mention UI action yet — the model calls the tool itself when it decides a query needs live web info; an explicit `@web` mention is a possible follow-up (see `ROADMAP.md`). |
| @Git (diffs/commits) | 🗺️ roadmap — `run_command` can already call `git diff` etc. today as a workaround |
| @Terminal (recent terminal output) | 🗺️ roadmap |
| @Lint errors / Problems | ✅ v1 — `get_problems` tool |
| @Past chats | 🆕 v2 — chat sessions are now addressable files under `.forge/chat/`, so a future @-mention of a past session is a small follow-up (roadmap for the @-mention UI itself) |
| @Cursor Rules (reference a specific rule file) | 🆕 v2 — rules exist now (`.forge/rules/`); explicit @-mention of one is roadmap |
| Drag-and-drop / paste images (multimodal) | 🗺️ roadmap — depends on the local model supporting vision (e.g. llava, qwen2-vl via Ollama) |
| Notepads (saved reusable context snippets) | 🆕 v2 — superseded by `.forge/skills/` (slash-command prompt templates), same job |
| `.cursorignore` / `.cursorindexingignore` | 🗺️ roadmap — today the indexer/tools use a fixed ignore list (`node_modules`, `.git`, etc.); a `.forgeignore` file is a natural v3 addition |

## 3. Editing surface

| Cursor feature | Forge status |
|---|---|
| Tab autocomplete (single + multi-line) | ✅ v1 — FIM completion via Ollama `/api/generate` |
| Cursor Prediction (jump to next suggested edit) | 🗺️ roadmap |
| Cmd+K inline edit | ✅ v1 |
| Agent multi-file diffs | ✅ v1 — pending-edit overlay + review panel |
| Accept / Reject / Accept All | ✅ v1 |
| Checkpoints (revert codebase to an earlier point in the conversation) | 🆕 v3.0 — every message is a checkpoint; restoring one reverts every file touched since AND truncates the chat, together |
| Auto-run / YOLO mode (auto-approve everything) | ✅ v1 — `requireApprovalForWrites` / `requireApprovalForCommands` + `autoApproveCommands` patterns |
| Iterate on lints (self-correct from diagnostics) | ✅ v1 — `get_problems` tool the agent can call post-edit (not yet automatic; roadmap: auto-invoke after every accepted edit) |

## 4. Customization & project config

| Cursor feature | Forge status |
|---|---|
| `.cursor/rules/*.mdc` (project rules, frontmatter: `description`, `globs`, `alwaysApply`) | 🆕 v2 — `.forge/rules/*.md`, same frontmatter shape, injected into the system prompt when always-on or when the active file matches a glob |
| Legacy single `.cursorrules` file | 🆕 v2 — a bare `.forge/rules.md` (no frontmatter) is treated as always-on, for the simple case |
| User/global rules (apply to every project) | 🗺️ roadmap — v2 rules are project-scoped only (`forge.userRules` global setting is a natural v3 add) |
| `.cursor/commands/*.md` (custom slash commands) | 🆕 v2 — `.forge/skills/*.md`, invoked as `/name` in chat |
| Memories (auto-remembered facts/preferences) | 🆕 v0.4.0 — `.forge/memory.md`, curated durable facts injected into every prompt; the agent adds to it via a `remember` tool call. 🆕 v0.5.0 — plus an actual periodic automatic review pass (every 6 turns, fire-and-forget) that proposes facts on its own instead of relying solely on the model remembering to call the tool. Paired with `search_chat_history` (semantic search over every past chat) for anything that doesn't need to be a standing fact. |
| MCP servers (`.cursor/mcp.json`) | 🗺️ roadmap — real value-add since it'd let Forge's agent call the same MCP tool ecosystem Claude/Cursor use; nontrivial (needs an MCP client) |
| Hooks (`beforeSubmitPrompt`, `afterFileEdit`, `beforeShellExecution`, etc.) | 🆕 v2 (subset) — `.forge/hooks/<event>` executable scripts for `session-start`, `before-write`, `after-write`, `before-command`, `after-command`; gating hooks can block an action by exiting non-zero |
| Model picker / multiple models per task type | 🆕 v0.5.0 — `forge.modelRouting` (mode → model) plus the original chat-vs-completion split; **Forge: Set Model for Mode** is the quick-pick UI, no JSON editing needed. 🆕 v0.7.0 — sub-agents get their own model setting (`forge.subAgentModel`), settable from the new in-webview Settings panel alongside per-mode routing. |
| Settings UI (no `.cursor/*.json` hand-editing) | ➖ Cursor has a full native settings UI | 🆕 v0.7.0 — an in-webview **Settings panel** (gear icon) for the settings most worth tweaking per-chat or often: context-window size (global and per-chat), temperature, approval toggles, keep-alive, status-message visibility, and sub-agent model/step-budget/nesting-depth. Everything else is still plain VS Code settings (`forge.*`). |

## 5. Chat & session management

| Cursor feature | Forge status |
|---|---|
| Persistent chat history | ✅ v1 (VS Code `workspaceState`) → 🆕 v2 (moved to `.forge/chat/*.json` in the repo, per your request) |
| Multiple chat tabs | 🆕 v2 — 🆕 v0.6.0: closing a tab now archives it (session file stays on disk) instead of permanently deleting it; a new "All Chats" panel lists open + closed chats and can reopen or permanently delete any of them |
| Branch a conversation | 🗺️ roadmap |
| Search across chat history | 🆕 v3.0 — searches every saved session, not just the open tab; 🆕 v0.5.0 — closed sessions' transcripts are now cached (keyed by `updatedAt`), so repeated searches stop re-reading every session file from disk each keystroke |
| Context-window summarization on long chats | 🆕 v3.0 — stale-read pruning + summarization of the older part of a long transcript, applied only to what's sent to the model (never to the persisted `.forge/chat/*.json`, so nothing is actually lost). Paired in v0.4.0 with `search_chat_history` so the model can pull back an exact detail a summary glossed over, instead of only the persisted-but-unreachable-from-the-prompt transcript. |
| Per-message checkpoints | 🆕 v3.0 (see Checkpoints above) |

## 6. Terminal & environment

| Cursor feature | Forge status |
|---|---|
| Agent-run terminal commands with streaming output | ✅ v1 — `run_command` tool, approval-gated |
| Background/long-running process monitoring | 🗺️ roadmap — today commands run to completion or timeout; no "start a dev server and keep watching it" primitive |
| Full autonomous loop (describe a task, agent keeps iterating until done/tests pass) | 🆕 v3.0 (partial) — Auto mode removes approvals and raises the iteration cap to effectively-unbounded, backed by a loop detector so it stops on thrashing rather than a fixed step count. It does not yet have an explicit "definition of done" it re-checks (e.g. auto-rerunning `npm test`) — see `ROADMAP.md`. |

## 7. Indexing

| Cursor feature | Forge status |
|---|---|
| Automatic codebase embedding index on open | 🗺️ roadmap — v1/v2 index is manual (**Forge: Index Workspace**); auto-index-on-open + incremental re-index on save is a natural next step |
| Respects ignore files | 🆕 partial — fixed ignore list today; `.forgeignore` is roadmap (see @-mentions section) |

## 8. Team/enterprise

Cursor's team admin console, analytics, and privacy-mode toggles don't have a meaningful local-single-user equivalent and are intentionally out of scope for Forge.

---

**Bottom line on this pass:** modes (Ask/Agent/Plan), multitask chat tabs, `.forge/chat` repo-stored history, `.forge/rules`, `.forge/skills` (slash commands), and a first cut of `.forge/hooks` are now real, working features (🆕 v2 below). Everything marked 🗺️ is catalogued and prioritized in `ROADMAP.md`, not forgotten.
