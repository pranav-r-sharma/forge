# Hand-off — Forge (VS Code local coding agent)

Written to the owner's `session-handoff` framework (`/Users/pranavsharma/Code Projects/Knowledge Base/frameworks/session-handoff.md`), after it was updated. If this file disagrees with `USER_BRIEF.md`, `DECISIONS.md`, `PROGRESS.md` or `git log`, those win.

## 1. Header

- **Written:** 2026-10-03, by Claude (Sonnet 5.5; the session started on Opus 5.5 and switched models mid-way).
- **Repo:** `/Users/pranavsharma/Code Projects/Local LLM Tools/forge`. **Branch:** `v0.15.0-work`. **Last code commit:** `dc3fca0`. **Last commit before this handoff:** `f06615e`. **Pushed:** yes, `origin/v0.15.0-work` was in sync at `f06615e` (GitHub `pranav-r-sharma/forge`). The commit that adds this file is not pushed yet.
- **Session goal:** the owner added six items on top of "run the live tests": (1) message queue, (2) fix the always-low context meter and show more memory info, (3) stop the agent stopping abruptly, (4) a way for Cursor to drive Forge without the UI, (5) a Cursor→Forge bridge like the existing Claude→Cursor one, (6) a robust grep. Then: adopt the owner's frameworks in the repo, push, and refresh this handoff.

## 2. What happened (chronological)

1. Session opened with a prompt to continue Forge: read the docs, confirm a clean git state, ask whether the hardware is free for LIVE-001. I checked: clean tree (one untracked log), HEAD `7898da9`. Owner then said **hold off on the tests** (they are using the Mac). No model has been loaded all session.
2. Owner asked "what's the rule with using Cursor" and then "global or repo level". Answer: global `~/.claude/rules/agent-bridge.md` (Cursor first, Composer/Grok only) plus the repo's cost-aware rule (small work yourself). They conflict on wording; the repo rule wins here. Owner said make the cost-aware rule global. My first edit was **blocked by the auto-mode classifier** (self-modification of my own rules file). Owner approved explicitly; I added the line (global rule, 2026-10-03). Owner then challenged "so you are not going to follow the cost-aware approach" — I clarified it applies immediately in this session (it was already in the repo's CLAUDE.md).
3. Owner gave the six items. Before building I read the code and reported two bugs with evidence, no changes yet. Owner said yes to fix both, and to ask about the design questions.
4. **Item 2 (meter) — T-001, `4712970`.** Root cause: the meter summed `promptTokens`, which means tokens *evaluated* (cached prefix excluded). Evidence: trace `_devtools/e2e/results/suite1-t05-large-file-new-r2.trace.jsonl` last row, promptTokens 96 vs cachedTokens 5131. Fix: `src/util/contextUsage.ts`, test `test_v15_context_usage.ts` (8 checks).
5. **Item 3 (abrupt stops) — T-002, `bd0dca1`.** A reply with no tool call was always accepted as final. Now an empty reply, or a last sentence that promises an action ("Now I'll write the tests:"), triggers a nudge (cap 2). `classifyStalledReply` in `src/agent/toolProtocol.ts`; test `test_v15_stalled_reply.ts` (27 checks). I scanned 112 old transcripts: 8 ended on a pending-looking reply but all were real tool calls or Harmony fragments, so I could **not reproduce** the stop from history. The cause is from reading the code.
6. Owner answered my design questions (D-012..D-014): queue + steer (recommended), **file mailbox for the Cursor link (not my recommendation)**, upgrade `search_code` in place.
7. **Item 6 (grep) — T-003, `f78b1ff`.** Delegated to Cursor `composer-2.5`. Review found 6 real bugs, which I fixed: rg paths relative to cwd (broken file names on a `path` search), `/re/` lost case-sensitivity, JS scan ignored extra include globs, rg-only regex syntax (look-ahead) errored instead of falling back, duplicate context lines, extract dropped the closing brace. Test `test_v15_grep.ts` now 36 checks incl. rg-vs-JS parity.
8. **Item 1 (queue + steer) — T-004, `02960c9`.** Cursor `grok-4.7-high`. Attempt 1 failed ("Connection stalled repeatedly", no files changed); attempt 2 worked. I read the whole diff and changed nothing. 48 checks in `test_v15_queue_steer.ts`. Owner interrupted with "are you cursor at all? doesn't seem like" because they could not see Cursor working; I explained which parts Cursor wrote and that my part is review.
9. **Items 4+5 (bridge) — T-005, `dc3fca0`.** Cursor `grok-4.7-high`. File mailbox: Forge watches `.agent-bridge/inbox/forge/`, runs each file as a real chat, replies to `inbox/<from>/`. `forge.bridge.enabled` (default **off**) and `forge.bridge.defaultMode`. Reviewed, no changes. 63 new checks. Helper `_devtools/bridge/forge-bridge`.
10. Owner: "use my handoff framework and do the needful" → overwrote HANDOFF.md, created `KNOWLEDGE_BASE.md` and `logs/AGENT_USAGE.md` (T-006, `86b1995`).
11. Owner: "update the repo according to my frameworks, be very careful, commit first." I tagged `pre-frameworks-2026-10-03` (= `86b1995`), then added docs only: `USER_BRIEF.md`, `DECISIONS.md` (D-001..D-016, 11 back-filled), `TASK_LOG.md`, `CODE_MAP.md`, folder READMEs, `docs/briefs/`, `docs/archive/`, `.gitignore` secrets/weights patterns, `.vscodeignore` excludes, a CLAUDE.md section (T-007, `f06615e`). No code moved.
12. Owner said the update was available to clone; it was **not pushed**. I checked the remote, asked, and on "yes" pushed `7898da9..f06615e` (normal push).
13. Owner said the framework was updated. I read the new `session-handoff` framework and rewrote this file to its 12-section format (T-009).

## 3. Owner's intent and preferences

- Wants a local agent that is good, fast and efficient on the M5 Max (128 GB) — "Efficiency is paramount." Builds for that Mac; generous limits.
- Wants Cursor used visibly for large work and kept cheap: "minimize token usage via cursor (but dont compromise on the quality at all)". Hence: do small things myself, delegate large, review everything.
- Corrections they made: (a) "so you are not going to follow the cost aware approach" — they expect a new rule to apply right away, not "next session"; (b) "are you cursor at all? doesn't seem like" — they want visible evidence of delegation; say plainly who did what; (c) asked "global or repo level" — they care where a rule lives; (d) said "the framework has been updated" — frameworks change, re-read them before using.
- Style: brief, plain words; status updates (every 45 minutes even when idle); remaining token count stated before long/background runs. They answer questions with short "yes". They prefer to be asked on real design choices and chose the simpler file mailbox over my recommendation.
- Live tests are on **HOLD** while they use the Mac. Never load a model until they say it is free.
- They did not answer: should the bridge default on (D-015); commit or ignore the stray `_devtools/bench/req-ab-round2.log`; whether to push the revert tag.

## 4. Decisions

- **Decided** (see `DECISIONS.md`): D-012 queue + steer (owner; B and C rejected); D-013 file mailbox (owner; HTTP server+CLI and fully headless rejected); D-014 grep = upgrade `search_code` (owner; a separate grep tool rejected); D-016 keep `PROGRESS.md` and `src/<area>/` instead of the framework's exact names (approved by proxy: owner said "don't break anything"). D-001..D-011 back-filled from older rules.
- **Pending on the owner:** D-015 bridge on by default? (ships off, the safe state); D-010 requirements checklist default (revisit after LIVE-001); whether to rename to the framework's exact file names (D-016 revisit); commit or ignore the stray log; push the revert tag.

## 5. Current state

| Area | State | How verified |
|---|---|---|
| Typecheck | clean | `npm run typecheck` run just now |
| Unit tests | 55 files, 1,953 checks, 0 failed | `node _devtools/run-tests.js` run just now |
| Build | compiles | `npm run compile` ran after the frameworks commit; not re-run since (docs-only after) |
| Context meter fix | logic correct | unit tests + trace evidence; **not seen in the real panel** (LIVE-006) |
| Stalled-reply nudge | works with a fake model | unit + loop tests; **cause unconfirmed live** (LIVE-006) |
| `search_code` grep | works; rg and JS engines agree | 36 tests with parity; **not used by the real model yet** |
| Queue + steer | logic works | 48 tests; **UI never opened** (LIVE-007) |
| Mailbox bridge | watcher, mail format, recovery work | 63 tests with a fake runner, helper smoke-tested for exit codes; **never run in VS Code with a real model** (LIVE-008) |
| Frameworks docs | present | read back; docs only |

Untested/assumed: everything involving the real model, MLX server, the webview UI, VS Code approvals, and Cursor actually using `forge-bridge`. The owner's item 2 second half ("more memory available for usage" in the panel) is **not done** (T-008).

## 6. What went wrong

- The auto-mode classifier blocked my first edit of the global rules file until the owner approved. Lesson: edits to `~/.claude/rules/*` need explicit owner approval.
- Cursor `grok-4.7-high` can fail with "Connection stalled repeatedly" and change nothing; a plain retry worked (T-004).
- Cursor's grep code had 6 real bugs its own tests missed (the biggest: rg returns paths relative to cwd; its tests only exercised the JS engine for that case). Lesson: every behavior test must run on both engines, and delegated diffs need a careful read.
- I once thought a Cursor job had died (checked with the wrong `pgrep`); it was running. Check `ps aux | grep local/bin/agent`.
- My own first test for the stalled-reply fix used an unrealistic input (raw Harmony tokens) and failed; I corrected the test input, not the assertion.
- I could not reproduce the abrupt-stop from old traces. Do not call item 3 "confirmed fixed" before LIVE-006.
- The saved grep brief (`docs/briefs/T-003-search-code-grep.md`) is condensed, not verbatim; it says so.
- Rejected, do not retry without new evidence: a second `grep` tool beside `search_code`; a local HTTP server for the Cursor link (owner chose the mailbox, revisit only if the mailbox is too slow or needs live streaming); a fully headless Forge (too big: every tool is tied to the VS Code API).

## 7. Open items (priority order)

1. Ask the owner if the Mac is free; if yes run LIVE-001 (requirements A/B round 3), then recommend whether `forge.requirements.enabled` stays off. Then LIVE-002..LIVE-008 in `PENDING_TESTS.md`.
2. Owner questions: D-015 (bridge default), the stray log, push the tag, exact framework names.
3. T-008: "show more memory information" in the panel (owner item 2, first half). Not started.
4. Known limits: steered messages are not a requirements source; "Send now" does not cancel an in-flight model call.
5. Re-run the owner's docs task on the M5 Max.

## 8. Hidden state

- Git tag `pre-frameworks-2026-10-03` exists **locally only** (not pushed). Older tag `v0.15.0-dev.1` exists.
- Processes seen at write time: Ollama app (pid 1073, idle as far as I know), and `caffeinate -d -i -s -t 15000` (pid 8537, started 6:09 PM). **I did not start that caffeinate**; it is not mine, so do not kill it. No `mlx_lm` server and no Cursor agent running. Swap used: 0.
- `~/.claude/rules/agent-bridge.md` was edited this session (global cost-aware line). It loads at session start.
- Bridge mailbox: `.agent-bridge/` (gitignored) holds `inbox/cursor`, `inbox/claude`, `archive`, `wake.log`. Two old 2026-09-30 docs-task messages and today's replies were read and archived.
- Scratch briefs live in the session scratchpad (gone later); the saved copies are in `docs/briefs/`.
- No credentials or secrets were used or written.

## 9. Gotchas

- `bridge wake cursor "<task>" --model <id>`: the model flag goes **after** the task. Run it in the background and wait; never use `-fast` or `auto`.
- Cursor says "Connection stalled" sometimes: retry once. If "out of usage", use a Claude sub-agent (`sonnet-low`).
- Tests import `vscode`; a stub lives in `_devtools/stubs/vscode`. `npm test` runs everything.
- `.vscodeignore` excludes the new docs from the extension package; any new root `.md` you want kept out of the vsix needs adding there.
- The webview needs its message types in `src/webview/protocol.ts` and handlers in `media/webview.js`; a type error there shows in typecheck.
- `forge.bridge.*` settings are not in the in-panel settings list; set them in VS Code settings.
- Docs must be updated in the same commit as a feature: `docs/HARNESS_REFERENCE.md`, `PENDING_TESTS.md`, `PROGRESS.md`.

## 10. Next steps

1. `cd "/Users/pranavsharma/Code Projects/Local LLM Tools/forge" && git status -sb && git log --oneline -3` to confirm the state above.
2. Ask the owner: "Is the Mac free to start LIVE-001?" and the open D-015 / stray-log / tag questions.
3. If yes: check free memory and swap (`vm_stat`, `sysctl vm.swapusage`), then run LIVE-001 per `PENDING_TESTS.md` (gpt-oss-20b MXFP4-Q8, one model, stop at the first failure, state remaining tokens first).
4. Then T-008 (memory info in the panel), then LIVE-002..008.
5. After every step: tests, update `PROGRESS.md`/`TASK_LOG.md`/`DECISIONS.md`/`KNOWLEDGE_BASE.md`, one commit.

## 11. Where to look

| Need | File |
|---|---|
| Owner intent | `USER_BRIEF.md` |
| Choices and open decisions | `DECISIONS.md` |
| Tasks | `TASK_LOG.md`, briefs in `docs/briefs/` |
| Progress and "Next" | `PROGRESS.md` (this repo's progress log) |
| Lessons, rejected approaches | `KNOWLEDGE_BASE.md` |
| Worker runs | `logs/AGENT_USAGE.md` |
| Feature/setting detail | `docs/HARNESS_REFERENCE.md`, `CODE_MAP.md` |
| Live tests waiting | `PENDING_TESTS.md` |
| Cursor→Forge bridge | `docs/CURSOR_BRIDGE.md` |
| Standing rules | `CLAUDE.md`, `~/.claude/rules/`, Knowledge Base at `/Users/pranavsharma/Code Projects/Knowledge Base/CATALOGUE.md` |

Trust order if they disagree: `USER_BRIEF.md`, then `DECISIONS.md`, then `PROGRESS.md` and `git log`. This file loses.

## 12. Starter prompt

> You are continuing Forge in `/Users/pranavsharma/Code Projects/Local LLM Tools/forge` on branch `v0.15.0-work`. Read `CLAUDE.md`, `HANDOFF.md`, `USER_BRIEF.md`, `DECISIONS.md`, `PROGRESS.md` ("Next"), `PENDING_TESTS.md`, then run `git status` and `git log -3`. Live model tests are on hold: do not load any model until I say the Mac is free. First, ask me whether the hardware is free for LIVE-001 and re-ask the open questions in HANDOFF section 7. Do small work yourself; delegate only large work to Cursor and review every diff. Keep replies short and plain, and give a status update every 45 minutes.
