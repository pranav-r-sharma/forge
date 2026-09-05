# Forge cheat sheet — every feature, what it does, how, and when to use it

A single-file reference to everything Forge can do, from the first release through **0.13.0**. Organized by what you're trying to do, not by version — each entry says what it does, how it actually works (briefly), and when you'd reach for it. For "what changed and why," see `CHANGELOG.md`; for setup/prerequisites, see `README.md`; for Cursor-feature-by-feature parity, see `CURSOR_PARITY.md`.

Version tags like *(0.9.0)* mark when something shipped, so you can tell what's new since you last looked at this.

---

## 1. Modes — pick how much autonomy the agent has

| Mode | What it does | When to use it |
|---|---|---|
| **Ask** | Read-only Q&A. Tools limited to reading/searching — no edits, no commands. | Understanding code, asking "how does X work," before you're ready to change anything. |
| **Plan** | No tools at all — the model drafts a step-by-step plan in plain text for you to review. Click **Execute plan** to hand off to Agent mode with that plan injected as context. | A change big/risky enough that you want to see the approach before any tool call happens. |
| **Agent** | Full read/write/run tool access, but edits are staged for your review (unless `forge.requireApprovalForWrites` is off) and shell commands ask first (unless auto-approved). | The default working mode for most tasks — you stay in the loop on what actually touches disk. |
| **Auto** | Same as Agent, but zero approval prompts — writes and commands both go straight through (the dangerous-command denylist still applies). Iteration cap is effectively unbounded (`forge.autoModeMaxIterations`, default 100000), with the loop detector as the real thrash-protection instead of a low step count. | Hands-off tasks you trust the agent to just finish — refactors, test-writing, anything you'd rather review as a diff at the end than approve step by step. Checkpoints (below) are what make this safe to use. |
| **Outcome** | "Reverse engineering" — state a destination, not steps. Fully autonomous like Auto. Optionally pair it with a **definition-of-done shell command**: Forge runs it after every "I'm done" claim and feeds a failure straight back in as evidence, so the loop keeps going instead of ending on an unverified claim. | "Make all the tests pass," "get the build green," anything with a command that can mechanically say yes/no to "is this actually done." Without a check command, Outcome mode is only as honest as the model's own self-report — see Known limitations in the README. |

Switch anytime from the mode strip above the message box. *(Ask/Plan/Auto: v2. Outcome: 0.5.0.)*

---

## 2. Chat & sessions

| Feature | What it does | How / when |
|---|---|---|
| **Multitask chat tabs** | Run several conversations at once — e.g. one investigating a bug while another refactors something unrelated. Background tabs keep working and show a spinner until you switch to them. | Double-click a tab title to rename it. Use separate tabs for genuinely unrelated threads of work; a single tab for one continuous task, since checkpoints/restore are per-chat (see Known limitations if two tabs touch the same file). |
| **Chat history in your repo** | Every session is `.forge/chat/<id>.json` (full transcript, mode, model used), plus `.forge/chat/index.json` for the tab list — plain JSON, travels with the project, not hidden app-support state. | Gitignore `.forge/chat/` if you don't want chat logs committed. |
| **Chat-persistence hardening** *(0.9.1)* | Every save validates itself (reads back and re-parses before committing) and rotates a one-generation-back `.bak`. A damaged session recovers, in order: leftover `.tmp` → rolling `.bak` → best-effort rebuild from the crash-recovery log (labeled as lossy) → an empty shell with a visible notice — never a chat you simply can't open. | Automatic — nothing to turn on. **Forge: Export All Chats** bundles every saved chat into one portable JSON file, and doubles as a bulk repair pass since exporting opens (and so recovers) every chat it touches. |
| **Search** | 🔍 icon in the header searches every message in every saved chat, not just the open tab — results show which chat and jump you there. Closed sessions are cached, so typing doesn't re-read every chat file per keystroke. | Finding a decision or detail from a past conversation without remembering which chat it was in. |
| **Checkpoints — Restore to here** | Every message you send starts a checkpoint. **⟲ Restore to here** on any message reverts every file edit made since AND drops the chat back to right before it, together, so files and transcript never end up out of sync. | The safety net that makes Auto mode's lack of approvals workable — if a run goes sideways, restore to before it started. |
| **Fork a chat** *(0.9.0)* | **⑂ Fork here** opens a brand-new chat containing everything up to that checkpoint (files reverted to match), leaving the original conversation untouched — non-destructive alternative to Restore. | Wanting to try a different direction from an earlier point without losing the line of conversation you already have. |
| **Milestone log** *(0.9.0)* | Every checkpoint gets a short, mechanically-generated one-line digest (files edited/deleted, commands run, sub-agent calls, verify outcome) shown under each message — free, can't hallucinate, always available (unlike compaction's LLM-generated summary). Also injected into the system prompt as a cheap table of contents. | Skimming what actually happened in a long session without scrolling the full transcript. |
| **Chat rename** | Double-click a tab title, or the ✎ icon in **All Chats**. A manual title is remembered and never auto-overwritten. | Any chat you'll want to find again by name later. |
| **Mode indicator sync** *(fixed 0.10.0)* | The mode pill always reflects the session's real mode, including right after Plan → Agent handoff via "Execute plan." | Nothing to do — this was a bug fix, not a feature to invoke. |

---

## 3. Editing surface

| Feature | What it does | How / when |
|---|---|---|
| **Review before write** | Every proposed file edit is staged, not written to disk, until you accept it — per-file or **Accept All** — from the chat panel or a real VS Code diff view (**Forge: Review Proposed Change**). | The default safety net in Agent/Outcome mode. Turn off with `forge.requireApprovalForWrites: false` if you want edits to land immediately (Auto mode always bypasses this). |
| **Targeted edits (search/replace)** | The agent's preferred edit shape for existing files: a small, unique `{"search","replace"}` snippet rather than rewriting the whole file. | Cheaper, safer, and easier to review than a full rewrite — this is what you want for most localized changes. |
| **Fuzzy whitespace-normalized fallback** *(0.11.0)* | If a `{"search","replace"}` call's search text doesn't match byte-for-byte, Forge retries with whitespace-normalized whole-line matching (trims + collapses internal whitespace) before giving up. Exactly one match → applies with an advisory note; 2+ matches → refused as ambiguous, same as the byte-exact case. | Kicks in automatically — recovers the common local-model failure mode of retyping the right lines with the wrong indentation. Doesn't help with a sub-line fragment or genuinely different content; those still need a corrected `search` string. |
| **Real indentation repair** *(0.12.0 — supersedes the 0.10.0 advisory)* | Detects the file's real indent unit (tabs vs. spaces, space width via GCD estimation over its existing indented lines), measures the `replace` block's own indent depths, and remaps each line to the file's unit at the matching depth — before the edit lands, on both the exact-match and fuzzy-match paths. Template-literal-aware so it never touches whitespace-looking characters inside a JS/TS template string; falls back to leaving a block untouched if it can't confidently determine both the file's unit and the block's structure. | Automatic, no setting. This is what actually fixes the "right content, wrong indent depth/style" failure mode instead of only flagging it — see `reindentReplacement()` in `src/tools/fileTools.ts`. |
| **Balance-regression advisory** *(0.11.0)* | A crude, free check comparing `{}`/`()`/`[]` counts before and after an edit — flags a bracket type that was balanced before and isn't after, right in the tool result. Advisory only, never blocks. | Always on. Treat it as a nudge to double-check the diff, not a guarantee something's wrong (or right) — it doesn't understand strings/comments. |
| **Cmd+K inline edit** | Select code, describe the change in an input box, get an in-place diff you accept (Cmd+Enter) or reject (Cmd+⌫). One pending inline edit at a time. | Quick, surgical, single-selection edits where opening the full chat feels heavyweight. |
| **Tab autocomplete** | Ghost-text completions from a local fill-in-middle model as you type, via Ollama's `/api/generate` with `prompt`/`suffix` — works across qwen2.5-coder, deepseek-coder, starcoder2, codegemma, codellama, etc. without per-model special-token handling. | Pick a small, fast dedicated model (`forge.completionModel`) rather than reusing a big chat model — **Forge: Select Autocomplete Model**. Toggle on/off with **Forge: Toggle Tab Autocomplete**. |
| **`get_problems` tool** | Lets the agent read the editor's own diagnostics (errors/warnings) for a file or the whole workspace. | Not yet auto-invoked after every edit (roadmap) — the agent calls it when it decides to check, or you can ask it to. |

---

## 4. Codebase search & retrieval (`@codebase` / `search_codebase`)

| Feature | What it does | How / when |
|---|---|---|
| **Semantic search** | Cosine-similarity search over an embedding index of your workspace, with automatic keyword-search fallback if no embedding model is installed. | **Forge: Index Workspace for @codebase Search** to build the index; `@`-mention or ask the agent something and it calls `search_codebase` itself. |
| **Boundary-aware chunking** *(0.11.0)* | Files are chunked at detected declaration boundaries (function/class/interface/etc. across JS/TS/Python/Go/Rust/Java/C#, decorators kept attached) instead of fixed 120-line windows — falls back to fixed-window only where no boundary appears in time. | Automatic; bumped the index cache format, so your workspace re-indexes once after updating to 0.11.0. |
| **Open-tab / recency weighting** *(0.11.0)* | A chunk in a file you have open, or one touched in the last 30 minutes, gets a small ranking boost — enough to break a close tie, never enough to beat a genuinely more relevant result elsewhere. | Automatic, no setting. |
| **Import-graph pull-in** *(0.11.0)* | If the top search hit imports one of your other indexed files, that file's best-matching chunk is pulled into the results too, labeled `[Pulled in because X imports this file]`. | Automatic — helps when the real answer lives in a helper the top hit calls into. |
| **Code-aware embedding model** | `forge.embeddingModel` defaults to `nomic-embed-text`; `embeddinggemma` (`ollama pull embeddinggemma`, 622MB) is a code-tuned alternative that tends to retrieve more relevantly for code-heavy repos at a similar size. `nomic-embed-code`/`qwen3-embedding` are heavier options. | Worth trying if `@codebase` results feel off-target; the default hasn't changed to avoid forcing everyone to re-download/re-index. |
| **`search_code` tool** | Literal/regex text search across the workspace — the "grep" counterpart to `search_codebase`'s semantic search. | When you (or the agent) know the exact string/symbol you're looking for, rather than a conceptual question. |
| **`@`-mentioning files/folders** | Type `@` to attach a file *or folder* to your message; ↑/↓ arrows + Enter/Tab to pick, no mouse needed. A folder gives a shallow listing rather than dumping every file's contents into context. | Pointing the agent at something specific instead of relying on it to find the right file via search. |

---

## 5. Memory & context — surviving longer than one chat or one context window

| Feature | What it does | How / when |
|---|---|---|
| **`.forge/memory.md`** | A short, curated list of durable facts ("this repo uses pnpm," "staging creds live in `.env.staging`") injected into every system prompt in every chat. The agent adds to it via a `remember` tool call; you can hand-edit it directly. | **Forge: Open Memory File**. Keep it small and durable — a growing knowledge base belongs in `.forge/rules/` instead. |
| **Automatic memory review** *(0.5.0)* | Every 6 completed turns, a background pass (fire-and-forget) re-reads the recent conversation and proposes durable facts on its own, on top of whatever `remember` already caught mid-conversation. | Automatic; every proposal still goes through de-dupe. |
| **Relevance-based memory selection** *(0.10.0)* | When `.forge/memory.md` overflows its ~4000-char render cap, facts are ranked by keyword overlap against your current message instead of always dropping the oldest — an old-but-relevant fact survives the cut. | Automatic once memory is large enough to overflow. It's a keyword-overlap heuristic, not a real embedding — see Known limitations. |
| **Forge: Compact Memory** *(0.10.0)* | A deterministic, no-LLM-call prune: every fact appears pre-checked in a multi-select quick-pick; unchecking one archives it (not deletes) to `.forge/memory.archive.md`. | Whenever memory has accumulated stale facts quietly bloating every prompt. |
| **`.forge/project-log.md`** *(0.10.0)* | A cross-chat, workspace-wide log — after every turn in every chat, the same milestone digest already attached to that turn's checkpoint gets appended here too, no separate mechanism. Recent entries are injected into every chat's system prompt. | The fix for "a brand-new chat starts knowing nothing about the project" — automatic; **Forge: Open Project Log** to read it directly. |
| **`search_chat_history` tool** | Semantic search over every past chat's transcript, same embedding-index machinery as `@codebase`, pointed at `.forge/chat/*.json`. | The agent calls it when you reference something that sounds like it was already discussed ("like we talked about…") instead of asking you to repeat it. |
| **Context compaction & pruning** | Stale file reads (superseded by a later edit/read) collapse to a placeholder; once the live transcript passes a size budget derived from `forge.numCtx`, older messages fold into a short model-generated summary. **Never touches the persisted `.forge/chat/*.json`** — only what's sent to the model on the next call. | Automatic on long sessions. Scroll up or use Search to find anything summarized out of the model's current view. |
| **Crash-recovery log** | An append-only `.forge/chat/<id>.log.jsonl`, one line per tool call/result/decision, so a mid-session crash doesn't lose the record even if the last full snapshot is slightly behind. | Automatic; this is also tier 3 of the corrupted-session recovery hierarchy above. |
| **KV-cache prompt-prefix stability** *(0.11.0, invisible but real)* | Memory/project-log/milestone content used to live in the system message, rebuilt every turn — which busted a local server's prompt-prefix cache on every single call, since that content grows every turn unconditionally. It now lives at the tail of each turn's own (already-new) user message instead, so the system message stays byte-identical turn over turn whenever mode/rules/MCP-tools/structured-output haven't changed. | Nothing to configure — if you're running a real local Ollama/llama.cpp server, this should measurably speed up multi-turn sessions since more of the prompt can be served from cache. |

---

## 6. MCP servers *(0.11.0; HTTP transport 0.12.0)*

| Feature | What it does | How / when |
|---|---|---|
| **Native MCP client** | Forge connects to your own [MCP](https://modelcontextprotocol.io) servers and exposes their tools to the agent alongside its built-ins — same protocol Claude Desktop/Code and Cursor use. Hand-written stdio JSON-RPC client, zero new npm dependencies. | Configure `forge.mcp.servers` in `settings.json`: `[{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }]`. |
| **Streamable HTTP transport** *(0.12.0)* | A second transport for a custom MCP server you run as a standing network service instead of spawning per-chat over stdio — `{ "name": "my-tool", "url": "http://host:port/mcp", "headers": {...} }` in the same `forge.mcp.servers` list. Speaks MCP's Streamable HTTP spec (JSON-RPC over HTTP POST, `Mcp-Session-Id`, SSE-framed responses) via a hand-written client (`mcp/mcpHttpClient.ts`), same zero-dependency approach as the stdio client. | Your own MCP server is already a long-lived service rather than something Forge should spawn/own the lifecycle of — point Forge at its URL instead of a `command`. Standardization note: if your server already speaks MCP's stdio JSON-RPC correctly, nothing changes; a network-exposed custom server specifically needs the Streamable HTTP transport, not a bespoke REST shape — see README's "MCP servers" section for the full answer. |
| **Namespaced tool names** | Each remote tool shows up as `mcp_<server>_<tool>` (e.g. `mcp_github_search_issues`) — can't collide with a built-in tool or another server's tool, regardless of which transport that server uses. | Automatic. |
| **Approval-gated** | An MCP tool call goes through the exact same approval channel `run_command` uses — your `forge.autoApproveCommands`/`requireApprovalForCommands` settings apply here too. Available in Agent/Auto/Outcome modes only, never Ask/Plan. | Nothing extra to set up — it's the same trust model as shell commands, since an MCP tool is arbitrary third-party code with side effects Forge can't inspect ahead of time. |
| **Forge: Reload MCP Servers** | Disposes every connected client and reconnects from the latest `forge.mcp.servers` config. | After editing the config, or to restart a server that crashed. |
| **Status in Settings panel** | The ⚙ Settings panel's "MCP servers" section shows per-server connected/tool-count status. | Checking whether a server actually connected before wondering why the agent "doesn't have" a tool you expected. |

Known gap: server config (including any API token in a server's `env`) lives in plain `settings.json`, not `vscode.SecretStorage` — don't commit a workspace config containing a real token.

---

## 7. Terminal & background commands

| Feature | What it does | How / when |
|---|---|---|
| **`run_command` tool** | The agent runs a shell command and sees its output, approval-gated (unless auto-approved or in Auto/Outcome mode; the dangerous-command denylist always applies). | Builds, tests, git operations, anything scriptable. |
| **Background commands** *(0.9.0)* | `run_command` with `{"background": true}` starts a process (dev server, watcher) and hands back an id immediately instead of hitting the normal ~3-minute timeout; `check_background_command` polls output/status, kills it, or lists tracked ids — across as many further tool calls, even later turns, as needed. | Anything meant to keep running rather than finish. Capped at 5 concurrent; all are killed automatically on extension shutdown/reload. |
| **Background commands panel** *(0.10.0)* | Header panel (gear/play icon) lists every tracked background command across every chat tab with a **■ Stop** button, without asking the agent. | Checking on or killing a long-running process without a round-trip through chat. |
| **Forge: Open Terminal** *(0.9.0)* | Opens a real, ordinary VS Code integrated terminal at the workspace root — a plain user convenience, not visible to or drivable by the agent. | Anything you want to run yourself, side by side with the agent's own `run_command` calls. |

---

## 8. Web search & fetch *(0.8.0, opt-in)*

| Feature | What it does | How / when |
|---|---|---|
| **`web_search` tool** | Queries a real search backend — Tavily, Brave, Google Programmable Search, a self-hosted SearXNG instance, or a no-key DuckDuckGo scrape fallback, with an `auto` mode that falls through whichever are configured. | Turn on with `forge.webSearch.enabled: true`. The one Forge feature (alongside MCP servers) that reaches the open internet — off by default for exactly that reason. |
| **`web_fetch` tool** | Pulls a specific page's readable text (robots.txt-respecting), paged by character offset for long articles. Can't read PDFs/binaries — reports that honestly rather than returning garbage. | Following up on a search hit, or fetching a doc page you already have the URL for. |
| **API keys** | Tavily/Brave/Google keys live in `vscode.SecretStorage`, not `settings.json`. | **Forge: Set Web Search API Key** or the Settings panel. |

---

## 9. Project customization

| Feature | What it does | How / when |
|---|---|---|
| **Project rules** (`.forge/rules/*.md`) | Always-on or file-glob-scoped instructions injected into the system prompt — Cursor `.cursor/rules` equivalent. A bare `.forge/rules.md` (no frontmatter) is always-on. | **Forge: New Rule** to scaffold one. Coding conventions, "always use X library," anything that should shape every relevant turn. |
| **Skills / slash commands** (`.forge/skills/*.md`) | Reusable prompt templates invoked as `/name` in chat — Cursor custom-commands equivalent. | **Forge: New Skill**. A repeated multi-step instruction ("review this diff for security issues") worth saving once and reusing. |
| **Hooks** (`.forge/hooks/<event>`) | Executable scripts run at `session-start`, `before-write`, `after-write`, `before-command`, `after-command`, given a JSON payload on stdin. `before-*` hooks are gating — non-zero exit blocks the action, script output shown to the model as the reason. | **Forge: Open Hooks Folder** for the contract. Enforcing a project-specific policy (block writes to a generated folder, log every command run) beyond what rules alone can do. |

---

## 10. Sub-agents *(0.7.0)*

| Feature | What it does | When to use it |
|---|---|---|
| **`spawn_subagent` tool** | The agent delegates a self-contained piece of work to a nested, fully autonomous agent turn (own bounded step budget, no approval prompts) instead of doing everything inline. Shows as its own "↳ Sub-agent: …" card, updating with a summary when done — the sub-agent's own step-by-step trace stays out of the main transcript. Depth-capped (`forge.maxSubAgentDepth`, default 2, hard-ceiling 4). Stopping the parent also stops any in-flight sub-agent. | A task that decomposes into an independent chunk of investigation/work the parent doesn't need to see step-by-step — keeps a long task's main transcript readable. Configure the sub-agent's model (`forge.subAgentModel`) and step budget (`forge.subAgentMaxIterations`) in the Settings panel. |

---

## 11. Checkpoint-safe resumption & orchestration mode *(0.12.0; cost-aware planning 0.13.0)*

Local hardware can get interrupted mid-task in a way a cloud-hosted agent doesn't have to worry about — a reload, a restart, a machine that needs a break, or a big Auto/Outcome run you want to pick up again later instead of redoing. These pieces are the answer:

| Feature | What it does | How / when |
|---|---|---|
| **Immediate model-history persistence** | The conversation history the *model* sees is now saved the instant each tool call/result is added to it, not batched until the whole turn finishes. Fixes the root cause where an interrupted turn could resume with the model's own next prompt silently missing its last few steps. | Automatic, invisible — nothing to turn on. This is what makes the rest of this section actually safe to rely on. |
| **Task ledger (`plan_tasks` / `update_task`)** | Two built-in tools, always available in Agent/Auto/Outcome (not gated behind Orchestration mode below) — break a goal into named tasks, mark each `in_progress`/`done`/`failed` with a short outcome. Rendered into every turn's prompt automatically, same mechanism as milestones/memory/project-log. | Mandatory, not opt-in — the model uses these on any nontrivial multi-step Agent/Auto/Outcome turn so a resumed turn has an accurate record of what's actually finished. |
| **Auto-tracked sub-agent delegations** | Every `spawn_subagent` call is recorded on the ledger automatically the moment it starts and resolved with its summary the moment it returns — zero extra tool calls needed from the model. | Automatic whenever `spawn_subagent` is used, orchestration mode or not. |
| **Per-task log** (`.forge/chat/<id>.tasks.md`) | Each ledger entry's full outcome (not just the inline one-liner) is appended here as it's marked done/failed — a plain, human-readable "what happened" log separate from the JSON transcript and the crash-recovery `.log.jsonl`. | Skimming what a long autonomous run actually did without replaying the whole transcript. |
| **Orchestration mode toggle** | A per-chat checkbox (Agent/Auto/Outcome only) that changes the system prompt to have the model act as an orchestrator: plan on the ledger, dispatch pieces to `spawn_subagent` one at a time (sequential — the agent loop only ever makes one tool call per round-trip anyway), read back each outcome, decide what's next. Same tools either way — this only changes the *instructions* for using them. | A task that's naturally several independent chunks (e.g. "add tests for these 4 modules") where you want the main transcript to stay a high-level plan-and-report loop instead of one long inline chain. |
| **Detached chat panel** | **Forge: Open Chat in New Panel (detached from sidebar)** opens the same live session in a main-editor-area panel, separate from the Activity Bar sidebar — same `ChatSession`, updates in both places at once. | Wanting the chat next to a file instead of competing with the Explorer for sidebar space. Not specific to orchestration, but shipped in this round for the same "your setup, your layout" reasoning. |
| **Cost-aware task planning** *(0.13.0)* | `plan_tasks` can now tag each task with a `costTier` (`cheap`/`moderate`/`expensive`) and an optional `costNote`; if the model doesn't set one, `src/agent/taskCost.ts` backfills a heuristic guess from the task's own wording. The ledger renders each task's tier inline (`(cheap) Read config.ts`) plus a "Remaining task cost" summary line, and the orchestration-mode prompt now explicitly tells the model to dispatch cheaper tasks first when there's no dependency reason not to — fail fast, and more of the plan survives an interruption. | Automatic tagging happens on every `plan_tasks` call in Agent/Auto/Outcome (toggle via `forge.taskLedger.costAwarePlanning`); cheap-first ordering is a prompt instruction the model follows, not a scheduler that reorders anything for it. |
| **Expensive-plan review gate** *(0.13.0)* | When a plan's weighted cost score (`cheap`=1, `moderate`=3, `expensive`=8, summed) crosses `forge.taskLedger.expensivePlanReviewThreshold` (default 8), Forge pauses before committing the plan and shows an approval card listing every task with its tier, so you can approve or send the model back to revise — same approval-card UI as a shell-command confirmation, reusing `ApprovalBroker`. In Auto/Outcome mode (which by design never stops for approval) or with `forge.taskLedger.reviewExpensivePlans` off, you get a non-blocking warning in the transcript instead. | Agent mode + review setting on (both defaults) for a hard stop before a big plan starts; Auto/Outcome always gets the heads-up warning only. |

Known limitations: restoring a checkpoint (section 2) doesn't rewind the task ledger to match; the cost estimate is a coarse heuristic/single global threshold, not real time estimation — see README's Known limitations for both.

---

## 12. Models — routing, per-chat overrides, HW visibility

| Feature | What it does | How / when |
|---|---|---|
| **Model auto-detection** | Detects installed Ollama models and recommends a good default (qwen2.5-coder, deepseek-coder, etc.); switch anytime from the status bar. | **Forge: Select Chat Model**. |
| **Per-mode routing** *(0.5.0)* | `forge.modelRouting` maps mode → model (e.g. a reasoning model for Plan, your strongest coder for Agent/Auto/Outcome, a fast small model as the Ask default). | **Forge: Set Model for Mode** for a quick-pick UI instead of hand-editing JSON. |
| **Per-chat model override** *(0.10.0)* | Pins one specific chat to its own model regardless of routing/global default. Composer shows `⚙ model-name (this chat)` when set. | Settings panel → "This chat" → **Model for this chat**. Handy for "quick Q&A on a fast model in this tab, big coder model everywhere else." |
| **Resolution order** | Per-chat override → per-mode routing → `forge.chatModel` global default. | Good to know when a chat seems to be using an unexpected model. |
| **HW utilization** *(0.7.0, RAM/tokens-per-sec; GPU added same release)* | Composer footer shows live tokens/sec, context-window usage, system RAM, loaded-model VRAM (`/api/ps`), and best-effort GPU utilization via `nvidia-smi` (NVIDIA-only — silently omitted elsewhere). | **Forge: Show HW Utilization** to refresh on demand, or click the readout. |
| **Context-window RAM suggestion** *(0.9.0)* | When there's meaningfully idle RAM, the per-chat context-window override shows a "Use N" quick suggestion — a rough heuristic, not a precise calculation (Ollama's HTTP API doesn't expose the weights/KV-cache split). | A starting point to try and watch, not a guarantee it'll fit. |

---

## 13. Accuracy levers *(0.11.0, opt-in — all off by default)*

Each trades extra model calls (latency/compute) for a specific reliability improvement. None is on by default because this project has no way to verify against a live server whether it's a net win for your particular model/hardware — try one at a time, watch what changes, turn it back off if it doesn't help.

| Setting | What it does | When to try it |
|---|---|---|
| `forge.structuredOutput.enabled` | Swaps the fenced-` ```forge_action ` text contract for Ollama's constrained/structured `format` field (a JSON Schema the model is decoded against) — eliminates malformed tool-call JSON by construction on a server/model that honors it, with a graceful fallback to the ordinary parser otherwise. | The agent's tool calls sometimes come back malformed/unparseable with your current model. |
| `forge.planFirst.enabled` | One extra reasoning-only model call at the start of an Agent/Auto/Outcome turn, grounded with a few codebase-search hits, producing a short plan every subsequent step in that turn can see. | The agent seems to wander or thrash before settling on an approach. |
| `forge.selfCritique.enabled` (+ `forge.selfCritique.minLines`, default 40) | After a large `write_file`, one extra tightly-scoped call asks "does this look right" and folds a genuine concern back into that same turn. | Large edits occasionally ship an obvious mistake a second look would have caught. |
| `forge.bestOfN.enabled` (+ `forge.bestOfN.samples`, default 3) | Scoped to the riskiest step — a full-file rewrite of an existing file at 40+ lines — resamples a few alternatives and picks the one that best preserves the file's structure/length instead of committing to the first draft. | Full-file rewrites occasionally truncate or garble unrelated parts of a file. |

---

## 14. Settings panel & full settings reference

Click ⚙ in the chat header for an in-chat panel covering the settings worth tweaking often: context window (global + per-chat), temperature, approval toggles, keep-alive, status-message visibility, loop detection, the four accuracy levers above, sub-agent model/budget/depth, MCP server status, and the core web-search settings. Everything else is a plain `forge.*` VS Code setting.

| Setting | Default | What it does |
|---|---|---|
| `forge.ollamaBaseUrl` | `http://localhost:11434` | Where your Ollama server lives |
| `forge.chatModel` | *(auto)* | Model used for chat/agent |
| `forge.completionModel` | *(uses chat model)* | Model used for Tab autocomplete |
| `forge.embeddingModel` | `nomic-embed-text` | Model used to index the workspace |
| `forge.temperature` | `0.2` | Sampling temperature |
| `forge.maxAgentIterations` | `200` | Tool-call step cap in Agent/Ask/Plan |
| `forge.autoModeMaxIterations` | `100000` | Same cap for Auto mode |
| `forge.numCtx` | `32768` | Context window requested from Ollama |
| `forge.keepAliveMinutes` | `-1` | Minutes Ollama keeps a model loaded (`-1` = never unload) |
| `forge.requireApprovalForWrites` | `true` | Stage edits for review (Auto mode bypasses) |
| `forge.requireApprovalForCommands` | `true` | Ask before shell commands (Auto mode bypasses, denylist always applies) |
| `forge.autoApproveCommands` | *(safe read-only list)* | Regex patterns that skip approval |
| `forge.enableTabCompletion` | `true` | Ghost-text autocomplete on/off |
| `forge.completionDebounceMs` | `250` | Delay before requesting a completion |
| `forge.contextChunkCount` | `8` | Chunks `@codebase` returns |
| `forge.maxContextFileKB` | `200` | Skip huge files when reading/indexing |
| `forge.subAgentModel` | *(same as parent)* | Model for `spawn_subagent` turns |
| `forge.subAgentMaxIterations` | `40` | Step cap per sub-agent task |
| `forge.maxSubAgentDepth` | `2` | Max sub-agent nesting (hard-ceiling 4) |
| `forge.showStatusMessages` | `true` | Show the "what's it doing" status line |
| `forge.loopDetection.enabled` | `true` | Stop likely infinite loops in Auto/Outcome |
| `forge.structuredOutput.enabled` | `false` | See "Accuracy levers" above |
| `forge.planFirst.enabled` | `false` | See "Accuracy levers" above |
| `forge.selfCritique.enabled` | `false` | See "Accuracy levers" above |
| `forge.selfCritique.minLines` | `40` | Threshold for self-critique |
| `forge.bestOfN.enabled` | `false` | See "Accuracy levers" above |
| `forge.bestOfN.samples` | `3` | Candidates sampled when best-of-N is on |
| `forge.taskLedger.costAwarePlanning` | `true` | Tag `plan_tasks` entries with a cost tier (model-given or heuristic) and render them on the ledger |
| `forge.taskLedger.reviewExpensivePlans` | `true` | Pause for approval (Agent mode) before starting a plan over the cost threshold |
| `forge.taskLedger.expensivePlanReviewThreshold` | `8` | Weighted cost score (cheap=1/moderate=3/expensive=8, summed) that counts as "expensive" |
| `forge.mcp.servers` | `[]` | MCP servers to connect to — stdio (`command`) or, new in 0.12.0, Streamable HTTP (`url`) shape per entry |
| `forge.webSearch.enabled` | `false` | Turns on `web_search`/`web_fetch` |
| `forge.webSearch.provider` | `auto` | `auto`/`tavily`/`brave`/`google`/`searxng`/`duckduckgo` |
| `forge.webSearch.maxResults` | `8` | Results per `web_search` call |
| `forge.webSearch.timeoutMs` | `15000` | Per-request timeout |
| `forge.webSearch.cacheTtlMinutes` | `10` | Cache TTL for identical queries/pages |
| `forge.webSearch.blockedDomains` | *(none)* | Hostnames filtered out |
| `forge.webSearch.respectRobotsTxt` | `true` | Honor target site's `robots.txt` |
| `forge.webSearch.maxFetchChars` | `500000` | Cap on fetched-page body size |
| `forge.webSearch.searxngUrl` | *(none)* | Your SearXNG instance URL |

---

## 15. Command Palette reference

Every `Forge: …` command in one place:

| Command | What it does |
|---|---|
| **Forge: New Chat** | Opens a new chat tab |
| **Forge: Focus Chat** (Cmd/Ctrl+L) | Jumps to the chat panel |
| **Forge: Edit Selection with AI** (Cmd/Ctrl+K) | Inline edit on the current selection |
| **Forge: Accept / Reject Inline Edit** (Cmd/Ctrl+Enter / Cmd/Ctrl+⌫) | Resolves a pending inline edit |
| **Forge: Select Chat Model** | Choose the model used for chat/agent |
| **Forge: Select Autocomplete Model** | Choose the model used for Tab completions |
| **Forge: Set Model for Mode** | Per-mode model routing UI |
| **Forge: Index Workspace for @codebase Search** | Builds/rebuilds the semantic index |
| **Forge: Toggle Tab Autocomplete** | On/off |
| **Forge: Add File to Chat Context** | Attaches a file (right-click in Explorer) |
| **Forge: Add Selection to Chat** (Cmd/Ctrl+Shift+L) | Attaches the current selection |
| **Forge: Accept All Proposed Edits** | Applies every pending staged edit |
| **Forge: Reject All Proposed Edits** | Discards every pending staged edit |
| **Forge: Review Proposed Change** | Opens a real VS Code diff view for one pending edit |
| **Forge: Check Ollama Connection** | Diagnoses "Ollama offline" |
| **Forge: New Rule** | Scaffolds a `.forge/rules/*.md` file |
| **Forge: New Skill / Slash Command** | Scaffolds a `.forge/skills/*.md` file |
| **Forge: Open Hooks Folder** | Shows the hooks contract/folder |
| **Forge: Show HW Utilization** | Refreshes the tokens/sec, RAM, VRAM readout |
| **Forge: Open Memory File** | Opens `.forge/memory.md` directly |
| **Forge: Compact Memory** | Deterministic multi-select prune of memory facts |
| **Forge: Open Project Log** | Opens `.forge/project-log.md` |
| **Forge: Set Web Search API Key** | Stores a Tavily/Brave/Google key in SecretStorage |
| **Forge: Open Terminal** | Opens a real VS Code integrated terminal |
| **Forge: Export All Chats** | Bundles every saved chat into one JSON file |
| **Forge: Reload MCP Servers** *(0.11.0)* | Reconnects every configured MCP server |
| **Forge: Open Chat in New Panel (detached from sidebar)** *(0.12.0)* | Opens/refocuses the current chat in a main-editor-area panel, in sync with the sidebar view |

---

## 16. If you only remember seven things

1. **Restore to here** (on any message) undoes that message's turn and every file it touched — this is what makes Auto/Outcome mode safe to actually use hands-off.
2. **`.forge/memory.md`** + **`.forge/project-log.md`** are how Forge avoids re-explaining your project every new chat — worth glancing at occasionally (**Forge: Compact Memory** if either gets noisy).
3. **`@codebase`** (semantic search) beats `search_code` (literal grep) for "what handles X" questions; use literal search when you know the exact string/symbol.
4. **The four 0.11.0 accuracy levers are opt-in for a reason** — try one, judge it on your own hardware/model, don't assume all four together is strictly better (more model calls, more latency).
5. **MCP servers (`forge.mcp.servers`) turn Forge from "has its own built-in tools" into "has whatever tools you connect"** — the same approval gate as shell commands applies, since a connected server is arbitrary third-party code; as of 0.12.0 that includes servers reachable over HTTP, not just ones Forge spawns itself.
6. **The task ledger + immediate history persistence (0.12.0) exist for one reason: your hardware, unlike a cloud agent's, can get interrupted mid-turn** — a long Auto/Outcome run now resumes accurately instead of redoing finished work, and Orchestration mode is the same idea applied deliberately to a task you break into sub-agent-sized pieces up front.
7. **Cost-aware planning (0.13.0) tags every planned task cheap/moderate/expensive and nudges cheap-first ordering, and a plan that's expensive enough will pause for your review before it starts (or just warn you, in Auto/Outcome)** — it's a heuristic estimate and a prompt instruction, not a guarantee or a scheduler, but on constrained hardware it's the difference between finding out a plan was too big after an hour versus before you commit to it.

See `CHANGELOG.md` for exactly what shipped when and how it was verified, `ROADMAP.md` for what's cataloged but not built yet, and `CURSOR_PARITY.md` for the full Cursor feature-by-feature comparison.
