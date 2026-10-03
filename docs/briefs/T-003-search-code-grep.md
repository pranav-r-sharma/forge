# T-003 — search_code grep upgrade

Saved 2026-10-03 as sent to Cursor (`bridge wake cursor`, model composer-2.5). Result: done after review, commit f78b1ff (see logs/AGENT_USAGE.md)

---

Repo: Forge VS Code extension (TypeScript, ZERO runtime npm deps). Read CLAUDE.md first. Task: upgrade the agent tool `search_code` (src/tools/searchTools.ts `searchCodeTool`, registered in src/tools/index.ts) into a robust grep. Keep the tool name and keep backward compatibility (args `query`/`pattern`, `glob`, and `/regex/flags` query syntax must still work exactly as now).
Add optional args: `regex`, `caseSensitive`, `wholeWord`, `context` (cap 10), `include`, `exclude`, `path` (folder or ONE file, workspace-relative; reject paths outside the workspace), `mode` ("lines" default, "files", "count", "extract" — needs `path` to one file, returns the match plus its enclosing block / markdown section, capped by `maxLines` default 200), `multiline`, `maxResults` (default 500).
Engine: prefer VS Code bundled ripgrep (spawn with --json, no shell), fall back to the existing JS scan when rg is missing or fails. Both engines must give the same output format. Respect cancellation. Clear error text for a bad regex when `regex:true`.
Update the tool describe + exampleArgs concisely and any system-prompt text that documents search_code.
Tests: _devtools/runtime_test/test_v15_grep.ts. Cover every arg and mode, backward compat, bad regex, path escape rejection, extract on .py/.ts/.md, and JS-vs-rg parity.
Constraints: do not touch src/chat, src/agent/agentLoop.ts, media/webview.js; do not edit docs; do not commit. Report back: files changed, arg list, test counts, anything not done.

(The full original wording was sent inline in the bridge command; this is the same content, condensed when saved.)
