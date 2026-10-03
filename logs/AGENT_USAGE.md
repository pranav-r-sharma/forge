# Agent usage log

One row per worker run (including work done by Claude directly). Newest at the bottom.

| Date | Worker | Model | Task | Result | Commit |
|---|---|---|---|---|---|
| 2026-10-03 | self (Claude) | opus-5-5 | Context-meter fix (`contextUsage.ts`) + test | ok, 8 checks | 4712970 |
| 2026-10-03 | self (Claude) | opus-5-5 | Stalled-reply nudge (empty / announced action) + test | ok, 27 checks | bd0dca1 |
| 2026-10-03 | Cursor | composer-2.5 | `search_code` grep upgrade (ripgrep + JS fallback) | ok after review: 6 bugs fixed by Claude (rg relative paths, `/re/` case, multi-include, rg-only regex fallback, duplicate context, extract closing brace) | f78b1ff |
| 2026-10-03 | Cursor | grok-4.7-high | Queue + steer, attempt 1 | failed: "Connection stalled repeatedly", no files changed | — |
| 2026-10-03 | Cursor | grok-4.7-high | Queue + steer, attempt 2 | ok after review, no changes needed, 48 checks | 02960c9 |
| 2026-10-03 | Cursor | grok-4.7-high | File-mailbox bridge (`src/bridge/`, `forge-bridge`, docs) | ok after review, no changes needed, 63 checks | dc3fca0 |
