# Forge — a local, agentic coding assistant for VS Code

Forge is a VS Code extension that gives you a Cursor-style AI coding experience — modes, multitask chat, project rules/skills/hooks, multi-file agent edits, inline Cmd+K editing, and Tab autocomplete — running **entirely on your Mac** against a local [Ollama](https://ollama.com) model. No API keys, no cloud calls, no telemetry. Everything (code, prompts, file contents, chat history) stays on your machine, in your repo.

**One deliberate exception, and it's off by default:** web search (0.8.0). Nothing else in Forge can honor the "stays on your machine" promise once you ask it to search the live internet — a query has to leave your machine, and fetched pages come from third-party servers. `forge.webSearch.enabled` defaults to `false` specifically because of that; turn it on only when you want it, see "Web search" below for exactly what that does and doesn't send where.

See `CURSOR_PARITY.md` for a full feature-by-feature map against Cursor, and `ROADMAP.md` for what's planned next.

## What you get

- **Agent / Ask / Plan / Auto / Outcome modes** — Agent has full read/write/run autonomy; Ask is read-only Q&A with no side effects; Plan drafts a step-by-step plan for you to review before anything runs; Auto is fully autonomous with no approvals; Outcome is "reverse engineering" — state a destination and Forge works backward from it, with an optional command that automatically verifies "done" instead of taking the model's word for it. Switch anytime from the mode strip above the message box.
- **Multitask chat tabs** — run several conversations at once (e.g. one investigating a bug while another refactors something unrelated); background tabs keep working and show a spinner until you switch to them. Double-click a tab title to rename it.
- **Sub-agents** — the agent can delegate a self-contained sub-task to a nested, fully autonomous agent turn (`spawn_subagent`) and get a summary back, instead of doing everything inline in one long tool-call chain. Depth-capped, shares the parent's Stop button.
- **Chat history stored in your repo** — every session is a JSON file under `.forge/chat/`, not hidden app-support state, so it travels with the project.
- **In-chat Settings panel** — tweak context-window size (globally or per-chat), temperature, approval toggles, sub-agent model/budget, and status-message visibility without leaving the chat view.
- **HW metrics** — tokens/sec, context-window usage, system RAM, loaded-model VRAM, and best-effort GPU utilization, live in the composer footer.
- **Project rules** (`.forge/rules/*.md`) — always-on or file-glob-scoped instructions injected into the agent's system prompt, Cursor `.cursor/rules` equivalent. **Forge: New Rule** scaffolds one.
- **Skills / slash commands** (`.forge/skills/*.md`) — reusable prompt templates invoked as `/name` in chat, Cursor custom-commands equivalent. **Forge: New Skill** scaffolds one.
- **Hooks** (`.forge/hooks/<event>`) — executable scripts run at `session-start`, `before-write`, `after-write`, `before-command`, `after-command`; the two `before-*` hooks can block the action. **Forge: Open Hooks Folder** shows the contract.
- **Agent chat panel** (Cmd+L) — ask questions or hand off multi-step tasks. Forge can read files, search the codebase (literal or semantic), propose file edits, and run terminal commands, iterating on its own until the task is done.
- **Inline edit** (Cmd+K) — select code, describe the change, get an in-place diff you accept (Cmd+Enter) or reject (Cmd+⌫), like Cursor's Cmd+K.
- **Tab autocomplete** — ghost-text completions from a local fill-in-middle model as you type.
- **Review before write** — every file edit the agent proposes is staged, not written to disk, until you accept it (per-file or all at once) from the chat panel or a real VS Code diff view.
- **Command approval** — shell commands the agent wants to run are shown to you first, unless you've allow-listed that pattern.
- **@codebase search** — semantic search over your workspace if you've pulled an embedding model (`nomic-embed-text`), with an automatic keyword-search fallback if you haven't.
- **Memory** — a curated durable-facts file (`.forge/memory.md`) injected into every prompt, plus semantic search over every past chat (`search_chat_history`) so a long-running project's history is retrievable on demand instead of having to fit in one prompt. See "Memory" below.
- **Model picker + per-mode routing** — auto-detects installed Ollama models and recommends a good default (qwen2.5-coder, deepseek-coder, etc.); switch anytime from the status bar, and optionally route different modes to different models (`forge.modelRouting` / **Forge: Set Model for Mode**) since a reasoning model for Plan and a strong coder for Agent are genuinely different jobs.
- **Web search + fetch** (opt-in, off by default) — `web_search` queries a real search backend (Tavily, Brave, Google Programmable Search, a self-hosted SearXNG instance, or a no-key DuckDuckGo scrape fallback) and `web_fetch` pulls a specific page's readable text, robots.txt-respecting, paged by character offset for long articles. The one Forge feature that reaches the open internet — see "Web search" below.

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
code --install-extension forge-local-agent-0.8.1.vsix
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
- **Outcome** (new in 0.5.0) — "reverse engineering": you describe a destination, not steps, and Forge works backward from it. See below for the details — it's autonomous the same way Auto mode is (as of 0.7.0 this is actually enforced in code, not just claimed in the prompt — see the Changelog), plus a mechanism that keeps it honest about when the goal is actually met.

### Outcome mode — state the destination, not the steps

Pick **Outcome** from the mode strip, then describe an end state instead of a task: "the API returns valid JSON for GET /users and the existing tests still pass", "the login page has a working dark-mode toggle", "this build succeeds without warnings". Forge treats your message as a goal, not a to-do list — the system prompt has it restate the goal as concrete, checkable criteria, look at what's actually there right now, and work backward from the gap between the two, autonomously (same no-approval behavior as Auto mode, same dangerous-command exception, same checkpoint-before-every-turn safety net).

**Gaming detection (new in 0.9.0).** A fully autonomous mode iterating against a check with nobody reviewing each step has an obvious failure mode: making the check pass instead of actually fixing the problem — skipping/disabling the failing test, neutering an assertion into a tautology, silencing an error instead of fixing its cause, or editing the check command's own script. The system prompt now explicitly forbids this, and — because a prompt instruction alone isn't a guarantee — Forge separately, heuristically scans the edits made right before a check goes from failing to passing for exactly these patterns (see `src/agent/gamingDetection.ts`) and posts a visible warning in the transcript if it looks like it happened. This is deliberately advisory, not a hard gate: the turn still completes (a second, fuzzier check blocking a real "done" would just trade one kind of false confidence for another), but you get a clear "double-check this" flag instead of silently trusting a green check that didn't earn it. It's regex-based and not exhaustive — see Known limitations.

The part that makes this more than "Auto mode with a friendlier prompt" is the **definition-of-done command** — an optional field that appears below the mode strip whenever Agent, Auto, or Outcome mode is active. Set it to a shell command whose exit code means "the goal is met" (`npm test`, `curl -sf localhost:3000/health`, a custom check script, whatever fits) and Forge stops trusting the model's own opinion about being done: after every plain-text final answer, **Forge runs that command itself**, and only actually ends the turn if it exits 0. A non-zero exit gets fed straight back to the model as real evidence ("the goal is not met yet — this is not an opinion") and the turn keeps going instead of shipping an unearned "done." An always-failing check still can't run forever — the same loop detector that backs Auto mode notices the repeated failure and stops with an explanation.

If you don't set a check command, the model has to verify its own work some other way (re-reading a file, running a relevant command) before it's allowed to claim success — weaker than an automatic check, but still better than taking its word for it, and the hallucination-claim check from 0.3.0 still applies underneath all of this.

### Multitask (chat tabs)

The strip above the mode pills is a tab bar — click **+** for a new chat, click a tab to switch, click **×** to close it. As of 0.6.0, **closing a tab archives the chat, it does not delete it** — the chat disappears from the open-tabs strip, but its `.forge/chat/<id>.json` file stays on disk untouched. Click **📁 All Chats** in the header to see every chat, open or closed, and reopen any of them (clicking a title clears its closed flag and switches to it). Actually deleting a chat for good is a separate, still-confirmed action — the 🗑 icon next to each chat in the All Chats panel. Each open tab has its own mode, message history, and in-flight agent run; a tab working in the background shows a small pulsing dot until you switch to it.

**0.8.1 reliability fix:** switching, closing, renaming, and reopening chats could previously lose to a race condition — a background tab's constant autosaving could silently revert a close/rename/reopen that happened moments earlier, and clicking a tab while another switch was still in flight could pick the wrong one. Both root causes (unsynchronized concurrent writes to the chat index, and unserialized concurrent handling of these five operations) are fixed — see `CHANGELOG.md` for the detail and how it was verified.

**0.9.0 reliability fix:** some chats stopped opening entirely after that race — rename and delete still worked (they only ever touch the shared index, not the chat's own content file), but clicking to open one silently failed if its `.forge/chat/<id>.json` had been left truncated/corrupted by the exact race 0.8.1 fixed the *cause* of. That fix stopped new damage; it didn't repair files already damaged before you upgraded. Opening a chat now recovers automatically — from a leftover `.tmp` file if one exists (an abandoned write from the same historical race, still holding valid if slightly stale content), or otherwise a fresh, usable shell with a visible note explaining the earlier content is gone. Either way the chat opens again instead of staying a dead end.

**0.9.1 hardening — four more layers, so recovery is rarely needed and never lossy when it is.** Every save now (1) reads back and re-parses its own write before committing it, refusing to let a corrupted write ever become "the" saved version, and (2) rotates a one-generation-back `<id>.json.bak` alongside the live file. Opening a chat with a damaged content file now tries, in order: a leftover `.tmp`, then the rolling `.bak` (a complete, valid, only-slightly-stale session — far better than a reconstruction), then a best-effort rebuild from the append-only crash-recovery log (labeled clearly as a lossy reconstruction, not the exact original conversation), and only then the empty shell with a visible notice. And **Forge: Export All Chats** (Command Palette) bundles every saved chat into one JSON file at a location you choose — a manual copy you can keep somewhere Forge doesn't control, and exporting doubles as a bulk repair pass since it opens (and so recovers) every chat along the way. None of this claims to make chat loss impossible — real hardware failure or disk corruption can still outrun any of these layers — but the realistic "a write got interrupted or came back wrong" case now has three independent nets under it before you'd ever see the empty-shell message.

### Checkpoints — restore a chat (and your files) to an earlier point

Every message you send starts a checkpoint. Hover a message and click **⟲ Restore to here** (with a confirmation first) to revert every file edit made from that point on *and* drop the conversation back to right before it — both together, so your files and the chat transcript never end up out of sync with each other. This works the same in every mode, but it's what makes Auto mode's lack of approvals safe to use: if a run goes somewhere you didn't want, restore to the message before it started. Restoring doesn't require guessing what changed — Forge tracked exactly which files were touched and what they looked like right before your turn began.

**Fork a chat (new in 0.9.0).** Next to **⟲ Restore to here** is **⑂ Fork here** — instead of rewinding *this* chat and losing everything after that point, it opens a brand-new chat containing everything up to the checkpoint, leaving the original conversation completely untouched. Use it when you want to try a different direction from some earlier point without giving up the line of conversation you already have. The one place this can't be fully non-destructive: Forge has one real workspace per project, not a separate worktree per chat, so forking still reverts the checkpoint's tracked files on the *shared* disk, same as restoring would — the new chat's transcript matches what's actually on disk, but if you keep working in the original chat's tab afterward, its own later edits to those same files are only back on disk once it writes to them again. Same tradeoff "Restore to here" already has, just without deleting anything.

**Milestone log (new in 0.9.0).** Every checkpoint now also carries a short, mechanically-generated one-line digest of what that turn actually did — files edited/deleted, commands run, sub-agent delegations, the definition-of-done outcome — shown as a small caption under each message. Unlike context compaction's summary (an LLM call, made lazily, only once a session is big enough to need it, and inherently interpretive), this costs nothing, can't fail or hallucinate, and exists for every turn the moment it finishes. It's injected into the system prompt too, so the model itself has a cheap, always-available table of contents for the whole session — including the parts compaction has since folded away — instead of relying solely on what a summarization pass chose to keep.

### Context management — long sessions don't quietly lose information

Two settings control how much of your conversation Forge sends to Ollama on each turn: `forge.numCtx` (the context window it requests from the model) and internal pruning/compaction that keeps the *live prompt* bounded once a session gets long — stale file reads (superseded by a later edit or a newer read) get collapsed to a one-line placeholder, and once the transcript passes a size budget derived from `numCtx`, everything except the system prompt and the last dozen-or-so messages gets folded into a short model-generated summary. Critically, **this only affects what's sent to the model on the next call — it never deletes anything from `.forge/chat/`.** The full, uncompacted transcript is always there; scroll up, or use chat search (below) to find anything from earlier in a long session, even after it's been summarized out of what the model currently sees. A crash-recovery log (`.forge/chat/<id>.log.jsonl`, append-only, one line per tool call/result/decision) also means a mid-session crash or restart doesn't lose the record of what the agent was doing right up to that point, even if the last full snapshot is slightly behind.

### Memory — durable facts + searchable chat history

Context compaction (above) keeps a single long turn from blowing the context window, but it doesn't fix the bigger version of the same problem: a *project* easily outlives any one chat, and a fresh chat starts from nothing. Two pieces work together to fix that:

- **`.forge/memory.md`** — a short, curated list of durable facts ("this repo uses pnpm, not npm", "the user prefers tabs", "staging DB creds live in `.env.staging`"). It's injected into every system prompt, in every chat, the same way `.forge/rules/` is. The agent adds to it itself via a `remember` tool call when it learns something worth never forgetting; you can also open and hand-edit it directly with **Forge: Open Memory File**. It's deliberately meant to stay small — if it starts turning into a real knowledge base, that content belongs in `.forge/rules/` instead. As of 0.5.0, this isn't purely reactive: every 6 completed turns in a chat, Forge runs a small **automatic review pass** in the background (fire-and-forget, never blocks a turn) that re-reads the recent conversation and proposes anything durable it notices, on top of whatever the model already flagged mid-conversation via `remember`. Every proposed fact still goes through the same de-dupe, so this can only ever add a fact once.
- **Chat-history search** — every past chat (not just the open one) is chunked and embedded into a searchable index, incrementally updated after every turn. The agent can call `search_chat_history` itself when you reference something that sounds like it was already discussed or decided ("like we talked about…"), instead of asking you to repeat it or guessing. This is the same embedding-index machinery as `@codebase`/`search_codebase`, pointed at `.forge/chat/*.json` instead of your source files, with the same automatic keyword-search fallback if no embedding model is installed.

Together these mean a long-running project's context doesn't actually run out — it becomes something the agent looks up on demand rather than something that has to be kept, in full, in every prompt. Neither is retroactive: chat-history search only covers sessions that have been indexed (every session gets indexed as you use it, so this only matters for import scenarios), and memory only contains what's actually been written to `.forge/memory.md`.

### Search — find anything across every chat

Click the 🔍 icon in the header to search every message in every saved chat (not just the open tab) — results show which chat they're from and jump you straight there. Closed sessions' transcripts are cached in memory (keyed by when they were last saved), so typing a query doesn't re-read and re-parse every chat file from disk on every keystroke — only sessions that actually changed since the last search get re-read.

### @-mentioning files and folders

Type `@` to attach a file *or a folder* to your message — use **↑/↓ arrow keys** to move through the results and **Enter** or **Tab** to pick one, same as the `/` skill-command dropdown, no mouse required. Attaching a folder gives the agent a shallow listing of its contents rather than dumping everything in it into context; it can `list_dir`/`read_file` further in from there.

### Model routing — different models for different modes

One model doing chat, planning, and Tab autocomplete is a real compromise — local models have genuinely different strengths. `forge.modelRouting` maps mode → model (e.g. a reasoning-tuned model for Plan, your strongest coder for Agent/Auto/Outcome, a fast small model left as the default for Ask). Run **Forge: Set Model for Mode** for a quick-pick UI instead of hand-editing settings JSON. Resolution order for any given turn: a chat tab's own model override (the model-name button in the composer) wins first, then this mode routing, then `forge.chatModel` as the final fallback. Tab autocomplete and the embedding model stay on their own separate settings, unaffected by this.

### HW utilization

The composer footer shows live tokens/sec for the last response, context-window usage (last call's prompt+eval tokens vs. this chat's configured ceiling), system RAM, and how many models Ollama currently has loaded (and their VRAM footprint) — refreshed automatically after each turn, or click it / run **Forge: Show HW Utilization** to refresh on demand. RAM is always available (`os.totalmem()`/`freemem()`); loaded-model VRAM comes from Ollama's `/api/ps`. GPU utilization/VRAM (added 0.7.0) is best-effort via `nvidia-smi` and is silently omitted on machines without an NVIDIA GPU or without `nvidia-smi` on `PATH` — Apple Silicon, AMD, no discrete GPU — which is the common case for a local-Ollama laptop and not itself an error.

**Context-window suggestion from idle RAM (new in 0.9.0).** When there's meaningfully idle system RAM, the Settings panel's per-chat context-window override shows a "Use N" quick suggestion — a rough, clearly-labeled heuristic (scale the current `num_ctx` up in proportion to how much RAM is sitting idle, using only a fraction of it) for how much headroom there might be to raise it. This is deliberately **not** a precise calculation: the actual memory cost of Ollama's KV cache for a given `num_ctx` depends on model architecture details (layer count, hidden dimension, attention layout) that Forge has no way to query over Ollama's HTTP API — `GET /api/ps` reports a model's total resident size, not the weights/KV-cache split. Treat the suggestion as a starting point to try and watch (via the HW readout above), not a guarantee it'll fit.

### Sub-agents — delegate a sub-task, get a summary back

The agent can call `spawn_subagent` to hand off a self-contained piece of work to a nested, fully autonomous agent turn (its own bounded tool-call budget, no approval prompts) instead of doing everything inline. You'll see it as its own card in the transcript — "↳ Sub-agent: <task>" — that updates once the sub-agent finishes with a summary of what it found/did; the sub-agent's own step-by-step tool calls stay out of your main transcript so a long delegated investigation doesn't flood the chat. Nesting is capped at `forge.maxSubAgentDepth` (default 2, hard-ceilinged at 4) so a sub-agent can't spawn an unbounded chain of further sub-agents. Stopping the parent turn also stops any in-flight sub-agent — they share the same cancellation token. Configure which model runs sub-agent turns (`forge.subAgentModel`, blank = reuse the parent's) and their step budget (`forge.subAgentMaxIterations`) from the Settings panel below.

### Settings panel

Click the ⚙ icon in the header for an in-chat settings panel — the ones worth tweaking per-chat or often, without leaving the chat view or hand-editing `settings.json`: this chat's own context-window override, the global context window/temperature/keep-alive/approval toggles, whether brief status messages show, and the sub-agent model/step-budget/nesting-depth settings. Everything else is still a plain `forge.*` VS Code setting (see the table below).

**Per-chat context window.** A chat pinned to a light/fast model can usually afford a bigger context window than your global default, since a smaller model leaves more memory/VRAM headroom than a bigger one would — set it per-chat in the Settings panel instead of raising `forge.numCtx` for every chat. Leave it blank to use the global default.

### Chat rename

Double-click a chat's tab title, or click the ✎ icon next to a chat in the **All Chats** panel, to rename it. A manually-set title is remembered and never gets silently overwritten by the normal first-message auto-title behavior.

### Brief status messages

While the agent is working, a short line above the message box shows what it's doing right now — "Thinking with qwen2.5-coder:14b…", "Reading src/foo.ts…", "Running `npm test`…", "Delegating to a sub-agent: …" — so a long autonomous run (especially Auto/Outcome mode) doesn't look like it's just silently spinning. Toggle it off with `forge.showStatusMessages` or from the Settings panel if you'd rather only see the full tool-call trace.

### Terminal & background commands (new in 0.9.0)

**Forge: Open Terminal** (Command Palette) opens a real, ordinary VS Code integrated terminal at the workspace root — reuses the same "Forge" terminal tab if one's already open rather than piling up new ones. This is a plain user convenience, not a Forge-controlled surface: nothing you type there is visible to the agent, and the agent can't drive it — it's the opposite direction from `run_command`, where the agent runs something and you watch.

The agent side is `run_command` with `{"background": true}` — for anything that's *supposed* to keep running (a dev server, a file watcher) instead of hitting `run_command`'s normal ~3-minute timeout. It starts the process, hands back an id immediately, and the model follows up with the new `check_background_command` tool (`{"id"}` for output/status so far, `{"id","action":"kill"}` to stop it, `{"action":"list"}` if it's lost track of an id) across as many further tool calls — even later turns — as it needs, the same way you'd run `npm run dev &` in a real terminal and check back on it. Background commands are shared across every open chat tab (like pending edits), capped at 5 running at once, and every still-running one is killed automatically if the extension host shuts down or reloads, so a forgotten dev server doesn't outlive the session. See Known limitations for the Windows/process-tree and no-UI-panel caveats.

### Web search — `web_search` + `web_fetch` (opt-in, new in 0.8.0)

Everything else in Forge works entirely offline against your local Ollama model. Web search is the one deliberate exception, because it has to be: answering "what's the current API for library X" or "what does this error mean" sometimes needs information that isn't in the model's training data or your codebase, and getting it means a query leaving your machine and pages coming back from third-party servers. Rather than quietly compromise the "no cloud" claim the rest of this README makes, it's **off by default** (`forge.webSearch.enabled`) and every place that setting is described says exactly what turning it on means.

**Turning it on**: flip `forge.webSearch.enabled` in Settings (or the ⚙ Settings panel's new "Web search" section) — no restart needed. With it on, the agent gets two new tools, in every mode including Ask (both are read-only — no side effects on your code):

- **`web_search`** — a natural-language query, gets back titles/URLs/snippets from a real search backend.
- **`web_fetch`** — a specific URL (typically one from a `web_search` result), gets back that page's extracted readable text — scripts/styles/nav/header/footer stripped, not a raw HTML dump. Long pages are paged by character offset (same idea as `read_file`'s line ranges) so one page can't blow the whole context window; the tool result tells the model how to keep reading if there's more.

**Providers**: `forge.webSearch.provider` picks the backend, default `auto`:

| Provider | Needs | Notes |
|---|---|---|
| `auto` (default) | — | Tries, in order, whichever of the below are actually configured: Tavily → Brave → Google → SearXNG → DuckDuckGo. Falls through to the next on failure. DuckDuckGo needs no setup, so `auto` always has something to fall back to even with zero configuration. |
| `tavily` | API key | Purpose-built for LLM/agent consumption — results come pre-cleaned. Good default choice if you're setting up exactly one key. |
| `brave` | API key | Brave Search API. |
| `google` | API key **and** a Search Engine ID (`cx`) | Google Programmable Search Engine — most setup (create one at [programmablesearchengine.google.com](https://programmablesearchengine.google.com), configure it to search the whole web), free tier 100 queries/day. |
| `searxng` | An instance URL (`forge.webSearch.searxngUrl`) | Self-hosted, no third-party API key at all if you run your own instance — closest fit to Forge's local-first ethos. The instance needs `json` enabled under its `search:formats` config (most public instances disable this; use one you control). |
| `duckduckgo` | Nothing | Always available, zero setup, used automatically as the last resort in `auto`. Scrapes DuckDuckGo's no-JS HTML results page rather than calling a real API — there is no public, documented DuckDuckGo search API, so this is inherently more fragile than the others (breaks if DuckDuckGo changes that page's markup). Fine for occasional use; configure a real provider above for anything more than that. |

**API keys are stored in `vscode.SecretStorage`** (your OS keychain), not in `settings.json` — the one deliberate exception to "everything is a plain `forge.*` setting" in this extension, because credentials shouldn't sit in a plain-text file that might get synced or committed. Set them via **Forge: Set Web Search API Key** (Command Palette) or the Settings panel's "Web search" section, which shows each provider's configured/not-configured status without ever displaying the key itself.

**robots.txt** is respected by default (`forge.webSearch.respectRobotsTxt`, default `true`) — `web_fetch` checks the target site's `robots.txt` before fetching and refuses a disallowed path with an explanation, the same courtesy any well-behaved crawler extends. A missing or unreachable `robots.txt` fails open (allowed), per the spec's own default — a network hiccup fetching `robots.txt` should never block a legitimate fetch.

**Other settings** (`forge.webSearch.*`): `maxResults` (default 8), `timeoutMs` (default 15000), `cacheTtlMinutes` (default 10 — repeated identical queries/pages within this window don't re-hit the network or burn paid-API quota), `blockedDomains` (default none — hostnames to always filter out of results), `maxFetchChars` (default 500000 — caps how much of a page's raw body gets read).

**Known limitations**: the HTML→text extraction (`web_fetch`) is a hand-written regex/string-scan pipeline, not a real DOM-based parser (Forge ships zero runtime npm dependencies — see below — so it can't reach for cheerio/jsdom/@mozilla/readability) — it handles normal articles/docs pages well and will do worse than a real readability library on adversarial or unusual markup. PDFs and other binary content types are honestly rejected with an explanation rather than mis-extracted as garbage text — no PDF-parsing library is bundled, for the same dependency-free reason. The DuckDuckGo fallback specifically is an unofficial HTML scrape, not an API, and is the most likely piece to break first if its markup changes.

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
| `forge.subAgentModel` | *(same as parent)* | Model used for `spawn_subagent` turns |
| `forge.subAgentMaxIterations` | `40` | Tool-call step cap per sub-agent task |
| `forge.maxSubAgentDepth` | `2` | Max sub-agent nesting depth (hard-ceilinged at 4 regardless) |
| `forge.showStatusMessages` | `true` | Show the brief "what's it doing right now" line while the agent works |
| `forge.webSearch.enabled` | `false` | Turns on the `web_search`/`web_fetch` tools — the one setting that lets Forge reach the open internet, see "Web search" above |
| `forge.webSearch.provider` | `auto` | Which backend to use: `auto`, `tavily`, `brave`, `google`, `searxng`, or `duckduckgo` |
| `forge.webSearch.maxResults` | `8` | Results requested per `web_search` call |
| `forge.webSearch.timeoutMs` | `15000` | Per-request timeout for search/fetch calls |
| `forge.webSearch.cacheTtlMinutes` | `10` | How long identical queries/pages are served from cache instead of hitting the network again |
| `forge.webSearch.blockedDomains` | *(none)* | Hostnames always filtered out of search results |
| `forge.webSearch.respectRobotsTxt` | `true` | Whether `web_fetch` checks and honors the target site's `robots.txt` |
| `forge.webSearch.maxFetchChars` | `500000` | Cap on how much of a fetched page's raw body is read before extraction |
| `forge.webSearch.searxngUrl` | *(none)* | Your SearXNG instance URL, only used when `provider` is `searxng` or as part of the `auto` chain |

API keys for `tavily`/`brave`/`google` are NOT in this table — they're stored in `vscode.SecretStorage`, set via **Forge: Set Web Search API Key** or the Settings panel, not `settings.json`. See "Web search" above.

Most of the settings above (context window, temperature, keep-alive, approval toggles, status messages, sub-agent model/budget/depth, and the core web-search toggle/provider/max-results/robots.txt/SearXNG-URL settings) are also editable from the in-chat **Settings panel** (⚙ in the header) — see above.

## How it works, briefly

Rather than relying on any one model's native function-calling format (inconsistent across local models), Forge defines a small text contract: the model replies with a single fenced ` ```forge_action ` JSON block to call a tool (`read_file`, `list_dir`, `search_code`, `search_codebase`, `write_file`, `run_command`, `get_problems`, `remember`, `search_chat_history`, `spawn_subagent`, and — when enabled — `web_search`/`web_fetch`), or plain text when it's done. The extension executes the tool, feeds the result back, and repeats — a classic ReAct loop — up to `forge.maxAgentIterations` steps. The parser is written defensively (it'll recover a tool call even if a smaller model forgets the fence) since local models vary a lot in instruction-following.

File edits go through an in-memory "pending edit" overlay: the agent's own view of a file it just edited is immediately the new version (so it can make several dependent edits in one turn), but nothing touches your disk until you accept it. Tab autocomplete uses Ollama's `/api/generate` with `prompt`/`suffix` (fill-in-middle) and lets Ollama apply each model's own FIM template, so it works across qwen2.5-coder, deepseek-coder, starcoder2, codegemma, codellama, etc. without hand-maintaining per-model special tokens.

## Known limitations (0.9.1)

- **Web search is the one feature that sends data outside your machine, and it's off by default for exactly that reason.** With `forge.webSearch.enabled` on: your query text goes to whichever provider is configured (or DuckDuckGo's scrape endpoint by default), and `web_fetch` downloads pages from whatever third-party server hosts them. Nothing about the rest of Forge changes — this is scoped to the two web tools and only runs when the model actually calls them.
- **The HTML→text extraction backing `web_fetch` is a hand-written regex pipeline, not a real DOM parser** (kept dependency-free on purpose — see "Web search" above) — it does well on normal articles/docs pages and worse on adversarial/unusual markup than a library like `@mozilla/readability` would.
- **The DuckDuckGo fallback provider is an unofficial HTML scrape**, not a documented API — there is no free, public, officially-supported DuckDuckGo search API, so this is the most fragile of the five providers and the first thing likely to need a fix if DuckDuckGo changes their results-page markup.
- **`web_fetch` cannot read PDFs or other binary files** — it honestly reports "this is a PDF, not supported" rather than attempting extraction and returning garbage, since no PDF-parsing library is bundled (same zero-dependency reasoning as the HTML extractor above).
- **The 0.6.0 confirm-dialog fix (window.confirm → an in-DOM modal) is a best-effort fix for a real, documented VS Code webview limitation, but this sandbox cannot run the actual extension host to confirm it fixes what you saw.** If Auto mode (or anything else that used to call `window.confirm`) still doesn't work after updating, it's a different bug — please retest and report the exact symptom, an error toast if one appears, or what shows up in **Developer: Open Webview Developer Tools** (Command Palette → search for it) so it's diagnosable.
- **Sub-agents share the same workspace and `PendingEditManager` as their parent — there's no worktree-style isolation.** In practice this hasn't caused a conflict because a model only calls one tool (including `spawn_subagent`) at a time, so sub-agent turns run one after another, not truly concurrently — but if that ever changes, two sub-agents editing the same file could clobber each other the same way two multitask tabs already can (see below).
- **GPU utilization is NVIDIA-only, via `nvidia-smi`.** No metric is shown at all on Apple Silicon, AMD GPUs, or any machine without `nvidia-smi` on `PATH` — this is silent-by-design (see HW utilization above), not a bug, but it does mean the GPU readout won't appear for a lot of local-Ollama setups.
- Inline edit (Cmd+K) uses a simple input box for the instruction rather than a floating in-editor widget, and supports one pending inline edit at a time.
- No multi-root workspace support — Forge uses the first workspace folder.
- The semantic index is a flat cosine-similarity search over line-chunked files (no AST-aware chunking) — good for "what file handles X", not a replacement for `search_code` on exact symbols.
- Pending (unaccepted) proposed edits live in memory only and won't survive a full VS Code restart — review them before closing if you have some outstanding.
- Rules/skills are project-scoped only (no global/user-level rules yet); multitask tabs share one Ollama server so heavy concurrent use is bottlenecked by your machine's actual GPU/CPU throughput, not by Forge.
- **Checkpoints are per-chat, but files are workspace-wide.** If two multitask tabs edit the same file in an interleaved order, restoring one tab's checkpoint can clobber the other tab's later edit to that file — Forge doesn't attempt to resolve that conflict, it just restores what its own checkpoint recorded. Keep this in mind if you're running two Auto-mode tabs against overlapping files at once.
- **Chat search and cross-session listing are still a linear scan** over messages (0.5.0 added a per-session cache, so it's no longer a disk read per keystroke — see "Search" above — but it's not a real index); fine at personal, single-workspace scale, would need real indexing for hundreds of long chats.
- **The hallucination check (unverified-claim detection) is a narrow regex**, not real verification — it only catches "created/updated/wrote `path.ext`"-shaped claims and gives the model a couple of chances to correct itself; it's a mitigation, not a guarantee nothing is ever misreported.
- **Memory still can't force the model's hand.** `remember` (mid-conversation) and the automatic review pass (every 6 turns) both increase the odds something durable gets saved, but neither is a guarantee — the system prompt nudges, the review pass double-checks periodically, and that's it.
- **`.forge/memory.md` is intentionally not itself size-limited beyond what's injected per-turn** (`renderForPrompt()` caps at ~4000 chars, keeping the most recent facts) — if you or the agent let it grow very large, older facts silently stop being injected rather than erroring; open it directly with **Forge: Open Memory File** to prune it by hand.
- **Outcome mode without a definition-of-done command is only as honest as the model's own self-check.** With a command configured, "done" is a real exit code Forge checks itself; without one, it falls back to the same hallucination-claim mitigation as every other mode — set a check command whenever the goal can be expressed as one, it's a meaningfully stronger guarantee.
- **The definition-of-done command runs with the same permissions as everything else Forge does** — it's not sandboxed, and it runs automatically after every attempt in Agent/Auto/Outcome mode, so don't point it at something destructive or side-effecting that you wouldn't want run repeatedly and unattended.
- **Gaming-detection is a fixed set of regexes** (`.skip(`, tautological assertions, empty `catch`/bare `except: pass`, editing the check's own script, etc.), not real static analysis — it catches the common, cheap ways to fake a passing check, not every way, and in principle a legitimate edit (deleting a genuinely obsolete test) could trip a false positive. It's advisory (a warning in the transcript), not a gate, specifically because of that — see Outcome mode above.
- **Background commands (`run_command` with `background: true`) are killed via process-group signaling, which has no equivalent on Windows** — there, killing one falls back to a plain `child.kill()`, which (same as any shell-wrapped command) may not reach further descendants a shell spawned rather than exec-replaced. POSIX (macOS/Linux) kills the whole process tree.
- **No dedicated UI panel lists running background commands** — the only way to see one is to ask the agent to check (`check_background_command` with `{"action": "list"}`), same as you'd ask a person "is the dev server still running." They also aren't visible in a real terminal at all, since they're spawned directly rather than through one — a genuine gap from "just like a real terminal," traded off against the complexity of a dedicated panel for a first cut at this.
- **Forked chats share the fork-time file-reversion tradeoff with "Restore to here"** — see "Fork a chat" above: Forge has one real workspace per project, not a worktree per chat, so forking still writes the checkpoint's tracked files to the one shared disk.
- **None of 0.9.1's chat-persistence hardening is a guarantee against data loss** — it's four layers that each catch a realistic failure mode (a write that came back corrupt, a file damaged after the fact, a chat that needs manual archiving), not a claim that loss is now impossible. The rolling `.bak` is exactly one generation behind — two consecutive bad saves in a row (extremely unlikely, since each is validated before it's allowed to overwrite anything) could still outrun it down to the crash-log tier. The crash-log reconstruction (tier 3) is genuinely lossy: `ChatSession` truncates most logged entries to a few hundred characters before writing them, specifically to keep the log small, so a reconstructed transcript is a best-effort summary, not the original conversation byte-for-byte — it says so in the recovered chat itself. **Forge: Export All Chats** is a manual action, not automatic/scheduled — it only protects chats you actually remember to export.
- See `CURSOR_PARITY.md` for the full list of what's intentionally not built yet (MCP servers, @-mention of code symbols/docs, auto-indexing, etc.) — @Web itself shipped in 0.8.0 as the `web_search`/`web_fetch` tools above.

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
