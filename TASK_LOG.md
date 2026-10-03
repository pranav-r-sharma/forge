# Task log

One row per task. IDs are never reused. Tasks `P0-1`..`P0-15` and the later phases keep their IDs in the plan in `PROGRESS.md` (they pre-date this log). New work gets `T-###`.

| ID | Date | Task | Worker | Status | Commit | Brief |
|---|---|---|---|---|---|---|
| T-001 | 2026-10-03 | Fix context meter (count the full prompt, cache included) | self | done | 4712970 | — |
| T-002 | 2026-10-03 | Nudge stalled replies (empty / announced action) instead of ending the turn | self | done | bd0dca1 | — |
| T-003 | 2026-10-03 | Upgrade `search_code` to a robust grep | Cursor composer-2.5 (+ fixes by self) | done | f78b1ff | docs/briefs/T-003-search-code-grep.md |
| T-004 | 2026-10-03 | Message queue + steer | Cursor grok-4.7-high | done | 02960c9 | docs/briefs/T-004-queue-steer.md |
| T-005 | 2026-10-03 | File-mailbox bridge, Cursor → Forge | Cursor grok-4.7-high | done | dc3fca0 | docs/briefs/T-005-mailbox-bridge.md |
| T-006 | 2026-10-03 | Hand-off, knowledge base, agent usage log | self | done | 86b1995 | — |
| T-007 | 2026-10-03 | Bring the repo in line with the owner's frameworks (docs only, no code moves) | self | in progress | see `git log` | — |
| T-008 | — | Show more memory information in the panel (owner item 2, first half) | — | not started | — | — |
