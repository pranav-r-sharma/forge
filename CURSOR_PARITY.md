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
| Agent mode | Full autonomous tool use: read, write, run commands, iterate | ✅ v1 (was the only mode) → now one of three |
| Plan mode | Model drafts a step-by-step plan first; you approve before it touches anything | 🆕 v2 — `plan` mode: no tools available, produces a checklist, "Execute Plan" hands off to Agent mode |
| Custom modes (user-defined tool/model presets) | Save a named mode with its own system prompt, tool allowlist, model | 🗺️ roadmap |
| Multitask (parallel agent runs) | Several agent conversations progressing at once, e.g. across worktrees | 🆕 v2 (partial) — multiple chat **tabs/sessions** in one workspace, each with independent history/mode/model, running concurrently. True parallel *worktree* isolation is roadmap. |
| Background Agent (cloud sandbox, PR creation, Slack trigger) | Kicks off a remote agent run outside your editor | ➖ N/A locally — no cloud sandbox by design. Roadmap alternative: a local "detached run" that keeps iterating in a background terminal while you do something else. |

## 2. Context & @-mentions

| Cursor feature | Forge status |
|---|---|
| @Files / @Folders | ✅ v1 — `@` mention autocomplete attaches file contents |
| @Code (symbol) | 🗺️ roadmap — currently file-level only |
| @Codebase (semantic search over the whole repo) | ✅ v1 — `search_codebase` tool + embedding index, keyword fallback |
| @Docs (indexed external doc sites) | 🗺️ roadmap |
| @Web | 🗺️ roadmap (would need a local web-search tool) |
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
| Checkpoints (revert codebase to an earlier point in the conversation) | 🗺️ roadmap — would piggyback on the existing pending-edit history plus a snapshot on each accepted batch |
| Auto-run / YOLO mode (auto-approve everything) | ✅ v1 — `requireApprovalForWrites` / `requireApprovalForCommands` + `autoApproveCommands` patterns |
| Iterate on lints (self-correct from diagnostics) | ✅ v1 — `get_problems` tool the agent can call post-edit (not yet automatic; roadmap: auto-invoke after every accepted edit) |

## 4. Customization & project config

| Cursor feature | Forge status |
|---|---|
| `.cursor/rules/*.mdc` (project rules, frontmatter: `description`, `globs`, `alwaysApply`) | 🆕 v2 — `.forge/rules/*.md`, same frontmatter shape, injected into the system prompt when always-on or when the active file matches a glob |
| Legacy single `.cursorrules` file | 🆕 v2 — a bare `.forge/rules.md` (no frontmatter) is treated as always-on, for the simple case |
| User/global rules (apply to every project) | 🗺️ roadmap — v2 rules are project-scoped only (`forge.userRules` global setting is a natural v3 add) |
| `.cursor/commands/*.md` (custom slash commands) | 🆕 v2 — `.forge/skills/*.md`, invoked as `/name` in chat |
| Memories (auto-remembered facts/preferences) | 🗺️ roadmap — no automatic memory extraction yet; rules are the manual equivalent today |
| MCP servers (`.cursor/mcp.json`) | 🗺️ roadmap — real value-add since it'd let Forge's agent call the same MCP tool ecosystem Claude/Cursor use; nontrivial (needs an MCP client) |
| Hooks (`beforeSubmitPrompt`, `afterFileEdit`, `beforeShellExecution`, etc.) | 🆕 v2 (subset) — `.forge/hooks/<event>` executable scripts for `session-start`, `before-write`, `after-write`, `before-command`, `after-command`; gating hooks can block an action by exiting non-zero |
| Model picker / multiple models per task type | ✅ v1 (chat vs. completion model) → 🗺️ roadmap for full per-task routing (see `ROADMAP.md`) |

## 5. Chat & session management

| Cursor feature | Forge status |
|---|---|
| Persistent chat history | ✅ v1 (VS Code `workspaceState`) → 🆕 v2 (moved to `.forge/chat/*.json` in the repo, per your request) |
| Multiple chat tabs | 🆕 v2 |
| Branch a conversation | 🗺️ roadmap |
| Context-window summarization on long chats | 🗺️ roadmap — today `maxAgentIterations` just caps steps; no automatic mid-conversation compaction yet |
| Per-message checkpoints | 🗺️ roadmap (see Checkpoints above) |

## 6. Terminal & environment

| Cursor feature | Forge status |
|---|---|
| Agent-run terminal commands with streaming output | ✅ v1 — `run_command` tool, approval-gated |
| Background/long-running process monitoring | 🗺️ roadmap — today commands run to completion or timeout; no "start a dev server and keep watching it" primitive |
| Full autonomous loop (describe a task, agent keeps iterating until done/tests pass) | 🗺️ roadmap — closest today is Agent mode's ReAct loop capped at `maxAgentIterations`; a real "run until green" loop is on the v3 list (see `ROADMAP.md`) |

## 7. Indexing

| Cursor feature | Forge status |
|---|---|
| Automatic codebase embedding index on open | 🗺️ roadmap — v1/v2 index is manual (**Forge: Index Workspace**); auto-index-on-open + incremental re-index on save is a natural next step |
| Respects ignore files | 🆕 partial — fixed ignore list today; `.forgeignore` is roadmap (see @-mentions section) |

## 8. Team/enterprise

Cursor's team admin console, analytics, and privacy-mode toggles don't have a meaningful local-single-user equivalent and are intentionally out of scope for Forge.

---

**Bottom line on this pass:** modes (Ask/Agent/Plan), multitask chat tabs, `.forge/chat` repo-stored history, `.forge/rules`, `.forge/skills` (slash commands), and a first cut of `.forge/hooks` are now real, working features (🆕 v2 below). Everything marked 🗺️ is catalogued and prioritized in `ROADMAP.md`, not forgotten.
