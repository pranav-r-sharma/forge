# Forge — a local, agentic coding assistant for VS Code

Forge is a VS Code extension that gives you a Cursor-style AI coding experience — modes, multitask chat, project rules/skills/hooks, multi-file agent edits, inline Cmd+K editing, and Tab autocomplete — running **entirely on your Mac** against a local [Ollama](https://ollama.com) model. No API keys, no cloud calls, no telemetry. Everything (code, prompts, file contents, chat history) stays on your machine, in your repo.

See `CURSOR_PARITY.md` for a full feature-by-feature map against Cursor, and `ROADMAP.md` for what's planned next.

## What you get

- **Agent / Ask / Plan modes** — Agent has full read/write/run autonomy; Ask is read-only Q&A with no side effects; Plan drafts a step-by-step plan for you to review before anything runs, then hands off to Agent mode when you approve it. Switch anytime from the mode strip above the message box.
- **Multitask chat tabs** — run several conversations at once (e.g. one investigating a bug while another refactors something unrelated); background tabs keep working and show a spinner until you switch to them.
- **Chat history stored in your repo** — every session is a JSON file under `.forge/chat/`, not hidden app-support state, so it travels with the project.
- **Project rules** (`.forge/rules/*.md`) — always-on or file-glob-scoped instructions injected into the agent's system prompt, Cursor `.cursor/rules` equivalent. **Forge: New Rule** scaffolds one.
- **Skills / slash commands** (`.forge/skills/*.md`) — reusable prompt templates invoked as `/name` in chat, Cursor custom-commands equivalent. **Forge: New Skill** scaffolds one.
- **Hooks** (`.forge/hooks/<event>`) — executable scripts run at `session-start`, `before-write`, `after-write`, `before-command`, `after-command`; the two `before-*` hooks can block the action. **Forge: Open Hooks Folder** shows the contract.
- **Agent chat panel** (Cmd+L) — ask questions or hand off multi-step tasks. Forge can read files, search the codebase (literal or semantic), propose file edits, and run terminal commands, iterating on its own until the task is done.
- **Inline edit** (Cmd+K) — select code, describe the change, get an in-place diff you accept (Cmd+Enter) or reject (Cmd+⌫), like Cursor's Cmd+K.
- **Tab autocomplete** — ghost-text completions from a local fill-in-middle model as you type.
- **Review before write** — every file edit the agent proposes is staged, not written to disk, until you accept it (per-file or all at once) from the chat panel or a real VS Code diff view.
- **Command approval** — shell commands the agent wants to run are shown to you first, unless you've allow-listed that pattern.
- **@codebase search** — semantic search over your workspace if you've pulled an embedding model (`nomic-embed-text`), with an automatic keyword-search fallback if you haven't.
- **Model picker** — auto-detects installed Ollama models and recommends a good default (qwen2.5-coder, deepseek-coder, etc.); switch anytime from the status bar.

Zero runtime npm dependencies — the whole extension is hand-written TypeScript talking to Ollama's HTTP API with Node's built-in `fetch`.

## Prerequisites

1. **macOS** with [VS Code](https://code.visualstudio.com) installed, and its `code` CLI on PATH (Cmd+Shift+P → "Shell Command: Install 'code' command in PATH").
2. **Node.js 18+** (only needed once, to build the extension) — `brew install node` if you don't have it.
3. **[Ollama](https://ollama.com)** installed and running (`ollama serve`, or just open the Ollama app).
4. At least one coding model pulled, e.g.:
   ```bash
   ollama pull qwen2.5-coder        # good all-round agent/chat model
   ollama pull qwen2.5-coder:1.5b   # small, fast — nice for Tab autocomplete
   ollama pull nomic-embed-text     # optional: enables semantic @codebase search
   ```

## Install

Unzip this project, then from a terminal in that folder:

```bash
./install.sh
```

This runs `npm install`, compiles the TypeScript, packages a `.vsix`, and installs it into VS Code for you (it'll print manual instructions instead if it can't find the `code` CLI). Reload VS Code afterward and click the new Forge icon in the Activity Bar.

Prefer to do it by hand, or the script hits an issue?

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension forge-local-agent-0.2.0.vsix
```

Or skip the CLI entirely: in VS Code, open the Extensions view → "…" menu (top right) → **Install from VSIX...** → pick the `.vsix` file that `npm run package` produced.

To make changes and reinstall later, re-run `./install.sh` any time — `code --install-extension --force` overwrites the previous version.

## Using it

| Action | Shortcut |
|---|---|
| Open/focus chat | `Cmd+L` |
| Inline edit selection (or insert at cursor) | `Cmd+K` |
| Accept inline edit | `Cmd+Enter` |
| Reject inline edit | `Cmd+⌫` |
| Add selection to chat | `Cmd+Shift+L` |

> `Cmd+K` intentionally overrides VS Code's built-in Cmd+K chord shortcuts (theme picker, fold levels, etc.) while the editor has focus — same trade-off Cursor makes. Those chords still work everywhere else (e.g. from the Explorer).

> If `Cmd+L` doesn't focus Forge (e.g. it's already bound to GitHub Copilot Chat or something else you have installed), open **Keyboard Shortcuts** (`Cmd+K Cmd+S`), search "Forge", and rebind it — or just click the Forge icon in the Activity Bar.

**Chat panel**: type a request. Type `@` to attach a specific file's contents (autocompletes from your workspace). The agent narrates its steps as tool cards — reading files, searching, proposing edits, running commands — so you can follow along live, the same way you'd watch Cursor's agent work.

**Reviewing edits**: proposed changes show up in a panel above the chat with `+adds/-deletions` stats. Click **Review** to open a real side-by-side VS Code diff, or **Accept**/**Reject** directly. **Accept all** / **Reject all** handle a whole batch at once. If you'd rather have edits applied immediately without review, turn off `forge.requireApprovalForWrites` in Settings.

**Commands**: when the agent wants to run something in your terminal, it pauses and asks — unless the command matches `forge.autoApproveCommands` (a set of safe read-only patterns like `git status`, `npm test`, `ls`, is preconfigured; edit the setting to add your own, e.g. your project's build command).

**Model picker**: click the model name in the chat panel's footer, or the Forge entry in the status bar, to switch which Ollama model is used. Pick a smaller/faster model separately for Tab autocomplete via **Forge: Select Autocomplete Model**.

**Indexing**: run **Forge: Index Workspace for @codebase Search** (or the refresh icon in the chat panel header) to build the semantic index. Without an embedding model pulled, `@codebase`/`search_codebase` automatically falls back to keyword search — nothing breaks, it's just less smart.

### Modes

The pill strip above the message box switches modes per chat tab:

- **Agent** — full autonomy: reads, edits, runs commands, iterates until done. This is what v1 shipped as the only mode.
- **Ask** — read-only. The agent can `read_file` / `search_code` / `search_codebase` / `get_problems` to investigate, but `write_file` and `run_command` are refused. Good for "explain this" / "where does X happen" without any risk of it touching files.
- **Plan** — no tools at all; the model reads only what's already in the conversation/attached files and produces a numbered plan. Review it, then click **Execute plan** on the plan card to hand off to Agent mode, which executes it step by step with the plan pinned into its context.
- **Auto** (new in 0.3.0) — fully autonomous: every file edit and shell command runs immediately, with **no approval prompts at all**, except a small hard-coded denylist of genuinely destructive commands (`rm -rf /`, force-pushing over `main`/`master`, disk-format commands, fork bombs, etc.) that always still ask, even in Auto mode. Switching to it shows a confirmation dialog explaining this. Because nothing pauses for your review, two things back it up: a **checkpoint is saved automatically before every turn** (see below — one click undoes everything from that point on), and a **loop detector** watches for the agent repeating the same failing action and stops the turn with an explanation instead of grinding forever. On a genuine failure, Auto mode is instructed to diagnose and try a different approach rather than stopping to ask — that's the point of it — but it will still stop and explain itself if it's truly stuck or the task is done.

### Multitask (chat tabs)

The strip above the mode pills is a tab bar — click **+** for a new chat, click a tab to switch, click **×** to close it. Closing a tab asks for confirmation and then **permanently deletes** that chat's history from `.forge/chat/` — there's currently no "hide but keep" state, so if you want to keep a conversation around, just leave the tab open (or don't close your last one; Forge always keeps at least one chat alive). Each open tab has its own mode, message history, and in-flight agent run; a tab working in the background shows a small pulsing dot until you switch to it.

### Checkpoints — restore a chat (and your files) to an earlier point

Every message you send starts a checkpoint. Hover a message and click **⟲ Restore to here** (with a confirmation first) to revert every file edit made from that point on *and* drop the conversation back to right before it — both together, so your files and the chat transcript never end up out of sync with each other. This works the same in every mode, but it's what makes Auto mode's lack of approvals safe to use: if a run goes somewhere you didn't want, restore to the message before it started. Restoring doesn't require guessing what changed — Forge tracked exactly which files were touched and what they looked like right before your turn began.

### Context management — long sessions don't quietly lose information

Two settings control how much of your conversation Forge sends to Ollama on each turn: `forge.numCtx` (the context window it requests from the model) and internal pruning/compaction that keeps the *live prompt* bounded once a session gets long — stale file reads (superseded by a later edit or a newer read) get collapsed to a one-line placeholder, and once the transcript passes a size budget derived from `numCtx`, everything except the system prompt and the last dozen-or-so messages gets folded into a short model-generated summary. Critically, **this only affects what's sent to the model on the next call — it never deletes anything from `.forge/chat/`.** The full, uncompacted transcript is always there; scroll up, or use chat search (below) to find anything from earlier in a long session, even after it's been summarized out of what the model currently sees. A crash-recovery log (`.forge/chat/<id>.log.jsonl`, append-only, one line per tool call/result/decision) also means a mid-session crash or restart doesn't lose the record of what the agent was doing right up to that point, even if the last full snapshot is slightly behind.

### Search — find anything across every chat

Click the 🔍 icon in the header to search every message in every saved chat (not just the open tab) — results show which chat they're from and jump you straight there.

### @-mentioning files and folders

Type `@` to attach a file *or a folder* to your message — use **↑/↓ arrow keys** to move through the results and **Enter** or **Tab** to pick one, same as the `/` skill-command dropdown, no mouse required. Attaching a folder gives the agent a shallow listing of its contents rather than dumping everything in it into context; it can `list_dir`/`read_file` further in from there.

### HW utilization

The composer footer shows live tokens/sec for the last response and how many models Ollama currently has loaded (and their VRAM footprint), refreshed automatically after each turn — click it, or run **Forge: Show HW Utilization**, to refresh on demand. Backed by Ollama's `/api/ps`.

### Project rules — `.forge/rules/`

Run **Forge: New Rule** (Command Palette) to scaffold `.forge/rules/<name>.md`:

```markdown
---
description: What this rule is for
globs: ["**/*.ts"]
alwaysApply: false
---

Your instructions here — conventions, architecture notes, things the agent
should always/never do in this codebase.
```

`alwaysApply: true` (or a bare `.forge/rules.md` with no frontmatter) injects it into every turn; otherwise it's injected only when the file you're currently editing matches one of `globs`. Rules are re-read from disk on every message, so edits take effect immediately.

### Skills / slash commands — `.forge/skills/`

Run **Forge: New Skill** to scaffold `.forge/skills/<name>.md` — a reusable prompt template you invoke as `/name` in chat (autocompletes as you type `/`). Use `{{input}}` in the template to place whatever you typed after the command name; otherwise it's appended automatically. Example `.forge/skills/review.md`:

```markdown
---
description: Review the current diff for bugs before committing
---

Run `git diff` and review it for bugs, missed edge cases, and style
inconsistencies with the rest of the codebase. Report findings as a list;
don't propose edits unless asked.
```

Typing `/review` in chat runs that. It's also how Notepads-style reusable context works in Forge — just write the saved context as a skill.

### Hooks — `.forge/hooks/`

Run **Forge: Open Hooks Folder** for the contract. Drop an executable script (any shebang, `chmod +x`) named exactly `session-start`, `before-write`, `after-write`, `before-command`, or `after-command`; Forge runs it at that point in the loop with a JSON payload on stdin. `before-write` and `before-command` are gating — a non-zero exit blocks the action and the script's output is shown to the model as the reason. The others are fire-and-forget (logging, notifications, etc.).

### Chat history — `.forge/chat/`

Every session is `.forge/chat/<id>.json` (full transcript + which mode/model it used) plus a small `.forge/chat/index.json` for the tab list — both plain JSON, both in your repo. Gitignore them if you don't want chat logs committed:

```gitignore
.forge/chat/
```

## Settings

All under `Settings → Extensions → Forge` (or search `forge.` in Settings):

| Setting | Default | What it does |
|---|---|---|
| `forge.ollamaBaseUrl` | `http://localhost:11434` | Where your Ollama server lives |
| `forge.chatModel` | *(auto)* | Model used for chat/agent |
| `forge.completionModel` | *(uses chat model)* | Model used for Tab autocomplete — pick something small and fast |
| `forge.embeddingModel` | `nomic-embed-text` | Model used to index the workspace |
| `forge.temperature` | `0.2` | Sampling temperature for chat/agent |
| `forge.maxAgentIterations` | `200` | Cap on tool-call steps per turn in Agent/Ask/Plan — generous by design now that the loop detector, not this number, is the real thrash-protection (was `25` through 0.2.x) |
| `forge.autoModeMaxIterations` | `100000` | Same cap, but for Auto mode — effectively unbounded since Auto is meant to run hands-off |
| `forge.numCtx` | `32768` | Context window requested from Ollama (`options.num_ctx`). Check `ollama show <model>` for your model's real max and raise this toward it if you have the RAM/VRAM — Ollama's own default is smaller and silently truncates long sessions without this |
| `forge.keepAliveMinutes` | `-1` | Minutes Ollama keeps a model loaded after a request; `-1` = never unload between messages, `0` = Ollama's own ~5-minute default |
| `forge.requireApprovalForWrites` | `true` | Stage edits for review instead of writing immediately (Auto mode always bypasses this) |
| `forge.requireApprovalForCommands` | `true` | Ask before running shell commands (Auto mode always bypasses this except the dangerous-command denylist) |
| `forge.autoApproveCommands` | *(safe read-only list)* | Regex patterns that skip the approval prompt |
| `forge.enableTabCompletion` | `true` | Ghost-text autocomplete on/off |
| `forge.completionDebounceMs` | `250` | Delay before requesting a completion |
| `forge.contextChunkCount` | `8` | How many chunks `@codebase` returns |
| `forge.maxContextFileKB` | `200` | Skip huge files when reading/indexing |

## How it works, briefly

Rather than relying on any one model's native function-calling format (inconsistent across local models), Forge defines a small text contract: the model replies with a single fenced ` ```forge_action ` JSON block to call a tool (`read_file`, `list_dir`, `search_code`, `search_codebase`, `write_file`, `run_command`, `get_problems`), or plain text when it's done. The extension executes the tool, feeds the result back, and repeats — a classic ReAct loop — up to `forge.maxAgentIterations` steps. The parser is written defensively (it'll recover a tool call even if a smaller model forgets the fence) since local models vary a lot in instruction-following.

File edits go through an in-memory "pending edit" overlay: the agent's own view of a file it just edited is immediately the new version (so it can make several dependent edits in one turn), but nothing touches your disk until you accept it. Tab autocomplete uses Ollama's `/api/generate` with `prompt`/`suffix` (fill-in-middle) and lets Ollama apply each model's own FIM template, so it works across qwen2.5-coder, deepseek-coder, starcoder2, codegemma, codellama, etc. without hand-maintaining per-model special tokens.

## Known limitations (0.3.0)

- Inline edit (Cmd+K) uses a simple input box for the instruction rather than a floating in-editor widget, and supports one pending inline edit at a time.
- No multi-root workspace support — Forge uses the first workspace folder.
- The semantic index is a flat cosine-similarity search over line-chunked files (no AST-aware chunking) — good for "what file handles X", not a replacement for `search_code` on exact symbols.
- Pending (unaccepted) proposed edits live in memory only and won't survive a full VS Code restart — review them before closing if you have some outstanding.
- Rules/skills are project-scoped only (no global/user-level rules yet); multitask tabs share one Ollama server so heavy concurrent use is bottlenecked by your machine's actual GPU/CPU throughput, not by Forge.
- **Checkpoints are per-chat, but files are workspace-wide.** If two multitask tabs edit the same file in an interleaved order, restoring one tab's checkpoint can clobber the other tab's later edit to that file — Forge doesn't attempt to resolve that conflict, it just restores what its own checkpoint recorded. Keep this in mind if you're running two Auto-mode tabs against overlapping files at once.
- **Chat search and cross-session listing are a linear scan** over `.forge/chat/*.json` — fine at personal, single-workspace scale; would need real indexing to stay fast with hundreds of long chats.
- **The hallucination check (unverified-claim detection) is a narrow regex**, not real verification — it only catches "created/updated/wrote `path.ext`"-shaped claims and gives the model a couple of chances to correct itself; it's a mitigation, not a guarantee nothing is ever misreported.
- No multi-model-per-task-type routing yet (one chat model, one optional separate completion model) — see `ROADMAP.md`.
- See `CURSOR_PARITY.md` for the full list of what's intentionally not built yet (MCP servers, @-mention of code symbols/docs/web, auto-indexing, etc.).

## Testing & release process

Every build up through 0.2.0 was verified with `tsc --noEmit` (a permissive dev-only type shim, since this environment can't reach the real `@types/vscode`/`@vscode/vsce` packages) plus hand-written logic tests for pure functions — the diff algorithm, the tool-call JSON parser, the pending-edit lifecycle, frontmatter/glob parsing (see `_devtools/runtime_test/`). Those catch a real class of bug, but none of them exercise the actual extension host: multi-session orchestration bugs like 0.2.1's chat-delete issue live in how `ChatViewProvider`, `ChatSession`, and `ChatStore` talk to each other at runtime, which type-checking and isolated unit tests don't touch. This section is the honest fix for that gap, not a claim that it's already solved.

**What changes starting now:**

1. **`CHANGELOG.md`** — every release lists exactly what changed, why, and how it was verified (type-check only vs. actually run). If an entry doesn't say it was run in real VS Code, assume it wasn't.
2. **Real git history** — this repo now has version control (see below). Every fix from here on is its own commit with a message describing the bug and the fix, so you can `git log` / `git diff` a release instead of taking a summary on faith.
3. **A real integration test harness, runnable on your Mac** — `@vscode/test-electron` downloads an actual copy of VS Code and runs tests inside it (real webview, real filesystem, real extension host). This sandbox can't reach the download it needs, so these tests can't run here — but they're the highest-value thing to add next, specifically because they'd cover exactly the class of bug that just shipped (multi-session state, not pure functions). If you want this scaffolded (a `src/test/` suite plus `npm test` wired to `@vscode/test-electron`, seeded with a regression test for the close/delete bug), say so and it's a self-contained addition.
4. **A short manual QA checklist for anything touching chat/session state**, until (3) exists:
   - Open 3+ chat tabs, send a message in each, switch between them, close one — confirm it's gone from the tab strip *and* stays gone after reloading the window (`Cmd+Shift+P` → "Developer: Reload Window").
   - Confirm `.forge/chat/index.json` and the corresponding `<id>.json` are actually removed from disk after a delete, not just hidden in the UI.
   - Close every tab down to one and confirm Forge refuses to delete the last one instead of leaving you with no active chat.
   - Restart VS Code entirely and confirm the remaining chat(s) reload with their full history.
   - **For 0.3.0 specifically:** switch to Auto mode on a throwaway task, confirm it edits without prompting; then click "Restore to here" on the message before that turn and confirm the file(s) actually revert and the follow-up messages disappear from the chat. Deliberately make the agent fail the same command 3 times (e.g. ask it to run a command that doesn't exist) and confirm the loop detector stops it instead of retrying forever.
5. **Smaller, reviewable diffs** — going forward, bug fixes and small features ship as focused patches you can read in a few minutes (like this one), rather than large multi-file drops, so review is actually feasible instead of a leap of faith.

**Setting up git**, if you haven't already — from inside the project folder:

```bash
git init
git add -A
git commit -m "Forge v0.2.1"
```

From then on, every delivered update is a diff you can inspect with `git diff` or `git log -p` before you trust it, and you can always `git revert` a bad one.

## Troubleshooting

- **Status bar says "Ollama offline"**: run `ollama serve` (or open the Ollama app), then click the status bar item to retry.
- **"No models found"**: `ollama pull qwen2.5-coder` (or any model you like), then reselect the model.
- **Tab completions are slow or low quality**: pick a smaller dedicated completion model via **Forge: Select Autocomplete Model** — a 1.5B–3B coder model feels much snappier than reusing a large chat model.
- **Agent seems to loop or ignore tool results**: smaller/weaker local models sometimes drift from the JSON contract; try a stronger coding model (qwen2.5-coder:14b/32b, deepseek-coder-v2) for agent tasks if your hardware allows it.

---

Built for a local-first, no-cloud workflow. MIT-license your own code as you see fit — there's no license file bundled since this was generated for personal use; add one if you plan to share it further.
