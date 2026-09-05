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
| (No direct Cursor equivalent) | State a goal/end-state, not steps — the agent works backward and verifies its own progress | 🆕 v0.5.0 — `outcome` mode ("reverse engineering"): system prompt frames the message as a goal to restate as checkable criteria and close the gap toward, fully autonomous like Auto mode, plus an optional "definition of done" shell command (also usable in Agent/Auto) that Forge itself runs after every claimed-done answer — a failing check is fed back as evidence and the turn keeps going instead of ending on an unverified claim. 🆕 0.9.0: a heuristic, advisory scan (`agent/gamingDetection.ts`) flags edits that look like they gamed the check (skipped/disabled test, tautological assertion, silenced error, editing the check's own script) rather than fixed the real problem, plus explicit anti-gaming system-prompt language — a warning, not a gate. |
| Custom modes (user-defined tool/model presets) | Save a named mode with its own system prompt, tool allowlist, model | 🗺️ roadmap |
| Multitask (parallel agent runs) | Several agent conversations progressing at once, e.g. across worktrees | 🆕 v2 (partial) — multiple chat **tabs/sessions** in one workspace, each with independent history/mode/model, running concurrently. 🆕 v0.7.0: within a single turn, the agent can also delegate self-contained sub-tasks to nested **sub-agents** (`spawn_subagent`, depth-capped, fully autonomous, reports a summary back) — a different axis of parallelism-in-spirit than separate chat tabs. 🆕 0.12.0: an **Orchestration mode** toggle turns the main agent into an explicit orchestrator that plans a bigger task on a task ledger and dispatches it to sub-agents one at a time, reading each one's outcome back before deciding the next step — sequential by design (Forge's ReAct loop only ever makes one tool call per round-trip, so true concurrent sub-agents aren't how this works), closer to Cursor's own multi-step planning than to "parallel worktrees." True parallel *worktree* isolation is still roadmap. |
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
| Checkpoints (revert codebase to an earlier point in the conversation) | 🆕 v3.0 — every message is a checkpoint; restoring one reverts every file touched since AND truncates the chat, together. 🆕 0.9.0: **⑂ Fork here** does the same thing non-destructively — opens a new chat truncated at that checkpoint (files reverted to match) while leaving the original conversation untouched, instead of overwriting it. 🆕 0.12.0: a separate, non-reverting **task ledger** (`plan_tasks`/`update_task`, always on in Agent/Auto/Outcome) plus immediate (not batched) persistence of the model's own conversation history means an interrupted turn — a crash, a reload, hardware that just needs a break — resumes from an accurate record of what was actually finished, instead of redoing already-completed work. 🆕 0.13.0: `plan_tasks` now tags each task **cheap/moderate/expensive** (model-given or heuristically backfilled), the ledger surfaces a running cost total, the orchestration prompt tells the model to dispatch cheap tasks first when it can, and a plan whose total cost crosses a threshold pauses for your review (Agent mode) or gets a non-blocking warning (Auto/Outcome) before it starts — the same interruption-resilience goal, applied before the plan begins rather than only after. Deliberately a different mechanism from checkpoints, not a merge of the two — see README's Known limitations for how a checkpoint restore and the ledger can drift out of sync. 🆕 0.14.0: each task now gets its own small JSON resumability file on disk (`.forge/tasks/<sessionId>/<taskId>.json`, always current, not an append-only log), a lightweight link to whichever checkpoint was active when it was last touched, and `spawn_subagent`'s new `resumeTaskId` lets the model explicitly pick an interrupted `[~]`/`[!]` task back up — reusing that ledger entry and seeding the fresh sub-agent with its last known progress — instead of silently starting a duplicate. |
| Auto-run / YOLO mode (auto-approve everything) | ✅ v1 — `requireApprovalForWrites` / `requireApprovalForCommands` + `autoApproveCommands` patterns |
| Iterate on lints (self-correct from diagnostics) | ✅ v1 — `get_problems` tool the agent can call post-edit (not yet automatic; roadmap: auto-invoke after every accepted edit) |
| Reliable targeted edits from a weaker/local model (Cursor's frontier models rarely reproduce indentation wrong) | 🆕 0.11.0/0.12.0 — `write_file`'s `{"search","replace"}` edits fall back to whitespace-normalized fuzzy matching when the exact search fails (0.11.0), and as of 0.12.0 a mismatched indent **unit** (tabs vs. spaces, or a different space width) in the `replace` block is automatically detected and remapped to the file's real indentation depth-for-depth, rather than only being flagged advisory-only after the edit landed. A crude bracket-balance check still runs afterward as a free second-order sanity check. 🆕 0.14.0: a single stray-indent line no longer corrupts or declines the whole block's fix — a majority-vote width estimate (instead of exact GCD, which one outlier could collapse to a bogus width of 1) recovers the right scale for the rest of the block, and the remap now applies line-by-line, leaving only the genuinely unresolvable line(s) untouched and named in the advisory. |

## 4. Customization & project config

| Cursor feature | Forge status |
|---|---|
| `.cursor/rules/*.mdc` (project rules, frontmatter: `description`, `globs`, `alwaysApply`) | 🆕 v2 — `.forge/rules/*.md`, same frontmatter shape, injected into the system prompt when always-on or when the active file matches a glob |
| Legacy single `.cursorrules` file | 🆕 v2 — a bare `.forge/rules.md` (no frontmatter) is treated as always-on, for the simple case |
| User/global rules (apply to every project) | 🗺️ roadmap — v2 rules are project-scoped only (`forge.userRules` global setting is a natural v3 add) |
| `.cursor/commands/*.md` (custom slash commands) | 🆕 v2 — `.forge/skills/*.md`, invoked as `/name` in chat |
| Memories (auto-remembered facts/preferences) | 🆕 v0.4.0 — `.forge/memory.md`, curated durable facts injected into every prompt; the agent adds to it via a `remember` tool call. 🆕 v0.5.0 — plus an actual periodic automatic review pass (every 6 turns, fire-and-forget) that proposes facts on its own instead of relying solely on the model remembering to call the tool. Paired with `search_chat_history` (semantic search over every past chat) for anything that doesn't need to be a standing fact. 🆕 0.10.0 — relevance-based (keyword-overlap) selection when the fact list overflows its render cap instead of always dropping the oldest facts, plus **Forge: Compact Memory** (a deterministic multi-select prune, archived not deleted) and a new cross-chat `.forge/project-log.md` (reusing the existing per-turn milestone summary, injected into every chat's system prompt) so a brand-new chat isn't starting from zero project context. |
| MCP servers (`.cursor/mcp.json`) | 🆕 v0.11.0 — `forge.mcp.servers` (`{name, command, args?, cwd?, env?}` each), a hand-written zero-dependency stdio JSON-RPC client (`mcp/mcpClient.ts`/`mcp/mcpManager.ts`) speaking the standard `initialize`/`tools/list`/`tools/call` handshake. Every remote tool is namespaced (`mcp_<server>_<tool>`), approval-gated through the same channel `run_command` uses, and listed in the system prompt alongside the built-ins. **Forge: Reload MCP Servers** reconnects after a config change. 🆕 0.12.0: a second transport, Streamable HTTP (`{name, url, headers?}`, `mcp/mcpHttpClient.ts`), for a custom MCP server you run as a standing network service instead of spawning per-chat over stdio — both shapes coexist in the same `forge.mcp.servers` list, and every remote tool is namespaced/approval-gated identically regardless of which transport its server uses. Known gap: server config (including any API token) lives in plain `settings.json`, not `vscode.SecretStorage` — see README's Known limitations. 🆕 0.14.0: namespacing switched to `mcp__<server>__<tool>` (Claude Code's own double-underscore convention); a tool's real JSON Schema is now actually used to synthesize the model-facing example args/parameter summary instead of being fetched and discarded; and non-text content blocks (images, embedded resources) split out as UI attachments instead of being dropped or force-flattened into the model's text context. |
| Hooks (`beforeSubmitPrompt`, `afterFileEdit`, `beforeShellExecution`, etc.) | 🆕 v2 (subset) — `.forge/hooks/<event>` executable scripts for `session-start`, `before-write`, `after-write`, `before-command`, `after-command`; gating hooks can block an action by exiting non-zero |
| Model picker / multiple models per task type | 🆕 v0.5.0 — `forge.modelRouting` (mode → model) plus the original chat-vs-completion split; **Forge: Set Model for Mode** is the quick-pick UI, no JSON editing needed. 🆕 v0.7.0 — sub-agents get their own model setting (`forge.subAgentModel`), settable from the new in-webview Settings panel alongside per-mode routing. 🆕 0.10.0 — an actual per-chat model override (the resolution priority already put it first, nothing populated it): a "Model for this chat" dropdown in the Settings panel pins one specific chat to its own model, independent of every other chat or the global default. |
| Settings UI (no `.cursor/*.json` hand-editing) | ➖ Cursor has a full native settings UI | 🆕 v0.7.0 — an in-webview **Settings panel** (gear icon) for the settings most worth tweaking per-chat or often: context-window size (global and per-chat), temperature, approval toggles, keep-alive, status-message visibility, and sub-agent model/step-budget/nesting-depth. Everything else is still plain VS Code settings (`forge.*`). |

## 5. Chat & session management

| Cursor feature | Forge status |
|---|---|
| Persistent chat history | ✅ v1 (VS Code `workspaceState`) → 🆕 v2 (moved to `.forge/chat/*.json` in the repo, per your request). 🆕 0.9.0/0.9.1: a real corrupted-file case surfaced a durability gap Cursor's cloud-synced history doesn't have to think about — closed with validate-before-commit, a rolling `.bak` backup, a 4-tier recovery hierarchy (`.tmp` → `.bak` → crash-log reconstruction → empty shell), and a manual **Forge: Export All Chats** bundle-to-JSON command. |
| Multiple chat tabs | 🆕 v2 — 🆕 v0.6.0: closing a tab now archives it (session file stays on disk) instead of permanently deleting it; a new "All Chats" panel lists open + closed chats and can reopen or permanently delete any of them |
| Branch a conversation | 🗺️ roadmap |
| Search across chat history | 🆕 v3.0 — searches every saved session, not just the open tab; 🆕 v0.5.0 — closed sessions' transcripts are now cached (keyed by `updatedAt`), so repeated searches stop re-reading every session file from disk each keystroke |
| Context-window summarization on long chats | 🆕 v3.0 — stale-read pruning + summarization of the older part of a long transcript, applied only to what's sent to the model (never to the persisted `.forge/chat/*.json`, so nothing is actually lost). Paired in v0.4.0 with `search_chat_history` so the model can pull back an exact detail a summary glossed over, instead of only the persisted-but-unreachable-from-the-prompt transcript. |
| Per-message checkpoints | 🆕 v3.0 (see Checkpoints above) |
| Chat panel layout — a dockable/movable chat surface, not stuck in one sidebar | 🆕 0.12.0 — **Forge: Open Chat in New Panel (detached from sidebar)** opens the same live session in a main-editor-area panel, side-by-side with a file, in addition to the existing Activity Bar sidebar view — both stay in sync since they're two webview hosts onto one `ChatSession`. |

## 6. Terminal & environment

| Cursor feature | Forge status |
|---|---|
| Agent-run terminal commands with streaming output | ✅ v1 — `run_command` tool, approval-gated |
| Background/long-running process monitoring | ✅ 0.9.0 — `run_command`'s `{"background": true}` starts a process and hands back an id immediately instead of waiting for exit; the new `check_background_command` tool polls output/status/kills it across as many further tool calls (even later turns) as needed. Killed via POSIX process-group signaling (Windows falls back to a plain kill — narrower guarantee there). 🆕 0.10.0: a header panel lists every tracked background command (running/exited, exit code) with a one-click Stop button, instead of only being visible via the tool's own "list" action. |
| A real terminal you (not the agent) can use | ✅ 0.9.0 — **Forge: Open Terminal** opens an ordinary VS Code integrated terminal at the workspace root; the agent has no visibility into it either direction. |
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

**0.12.0 pass, at a glance:** a second MCP transport (Streamable HTTP, for network-deployed custom servers), real indentation repair (not just an advisory) on targeted edits, a detached chat panel separate from the sidebar, and a mandatory task ledger + immediate history persistence + an Orchestration mode toggle — all four aimed at the same underlying constraint local/self-hosted use runs into that Cursor's cloud-hosted agent doesn't: your own hardware can get interrupted, and a long autonomous run needs to survive that without silently redoing finished work.

**0.13.0 pass, at a glance:** cost-aware task planning — a direct follow-on to 0.12.0's task ledger, since knowing what's already finished only helps if the *rest* of the plan is also ordered sensibly. `plan_tasks` now estimates each task cheap/moderate/expensive, the ledger renders a running cost total, the orchestration prompt nudges cheap-first dispatch (fail fast, preserve more progress if interrupted), and a plan that's expensive enough pauses for your review before it starts (or just warns you, in modes that don't pause by design). Not something Cursor's cloud-hosted agent needs, for the same reason 0.12.0's resumption work wasn't — it isn't the one running on hardware that might get interrupted mid-plan.

**0.14.0 pass, at a glance:** three follow-ups closing gaps from the 0.11.0/0.12.0 rounds. MCP tool schemas are now actually used (real example args/parameter summaries instead of a discarded schema), non-text MCP content (images, embedded resources) renders as a UI attachment instead of being dropped or force-flattened into text, and tool namespacing matches Claude Code's own `mcp__server__tool` convention. `write_file`'s indentation repair (0.12.0) no longer lets one stray line in a long block corrupt or decline the whole edit — it fixes what it can and names what it can't. And the 0.12.0/0.13.0 task ledger gained the literal per-task JSON resumability file the original request envisioned, plus `resumeTaskId` so a sub-agent can explicitly pick up an interrupted task instead of quietly duplicating it — again, infrastructure Cursor's cloud-hosted agent has no equivalent need for, since it isn't the one running on hardware that gets interrupted.
