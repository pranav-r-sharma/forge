# Code map

Living doc: update it when files move or a new area is added. Feature-by-feature detail, settings and interactions: `docs/HARNESS_REFERENCE.md`. Each folder also has a short README.

## Entry points
- `src/extension.ts`: activation; builds the services, the chat view, the status bar, the optional file-mailbox bridge.
- `src/commands.ts`: VS Code commands. `src/statusBar.ts`: status bar item.
- `media/webview.js` + `media/webview.css`: the side-panel UI. Messages are typed in `src/webview/protocol.ts`.

## src/ areas
| Folder | Role |
|---|---|
| `src/agent/` | The agent loop (`agentLoop.ts`) and what it uses each step: prompt building, tool-call parsing (`toolProtocol.ts`), context compaction, loop detection, final-answer checks and nudges, verify-before-done, requirements checklist, approvals, checkpoints, trace log. |
| `src/chat/` | One chat session (`chatSession.ts`: turns, message queue, persistence) and the webview host (`chatViewProvider.ts`). |
| `src/tools/` | The agent's tools (registry `index.ts`): files, `search_code` grep, commands, background commands, web, memory, sub-agents, task ledger; edit-apply and argument checks. |
| `src/llm/` | Providers behind one interface; MLX server manager; OpenAI-compatible client. `src/ollama/` is the Ollama client and shared request/metrics types. |
| `src/forge/` | On-disk project state under `.forge/`: chat store, memory, rules, skills, hooks. |
| `src/indexing/` | Workspace and chat-history search. |
| `src/mcp/` | MCP clients and manager. |
| `src/websearch/` | Web search and fetch. |
| `src/completion/`, `src/inlineEdit/` | Tab completion; select-and-edit. |
| `src/bridge/` | File mailbox so Cursor can hand tasks to Forge (off by default). |
| `src/util/` | Settings (`config.ts`), paths, hardware sampling, context-meter math, logging, helpers. |

## Outside src/
| Path | Role |
|---|---|
| `_devtools/runtime_test/` | Unit tests (`test_*.ts`); run with `npm test`. |
| `_devtools/stubs/` | `vscode` stub for the tests. |
| `_devtools/bench/` | Benchmarks and probes (Python/TS, standard library only). |
| `_devtools/e2e/` | Acceptance tasks, results and traces (evidence, kept). |
| `_devtools/bridge/` | `forge-bridge` helper for Cursor. |
| `docs/` | Harness reference, Cursor bridge guide, briefs, archive. |
| `logs/` | `AGENT_USAGE.md`. |

## Project documents (see `CLAUDE.md`)
`USER_BRIEF.md`, `DECISIONS.md`, `TASK_LOG.md`, `PROGRESS.md` (the progress log), `HANDOFF.md`, `KNOWLEDGE_BASE.md`, `CODE_MAP.md`, `CHANGELOG.md`, `PENDING_TESTS.md`, `logs/AGENT_USAGE.md`.
