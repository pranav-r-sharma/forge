# User brief

The owner's intent, in their words. Copied from the owner's standing rules (`CLAUDE.md`) and messages. Never paraphrased away; add new lines, do not rewrite old ones.

## What Forge is
- "A VS Code extension (TypeScript, zero runtime npm dependencies) that gives a local, agentic coding assistant on a Mac." (`CLAUDE.md`)
- Built for "M5 Max, 128 GB memory ... plenty of memory. Use generous limits for the model wherever a limit applies" (owner rule, 2026-09-30).
- Efficiency is paramount; test constantly, monitor performance and efficiency, iterate (owner, 2026-09-26: "go start").
- Final acceptance test: "have the harness ... write a multi-file program" in a test repo inside this repo and "keep improving the harness until it works well".

## Standing directives
- Test only with gpt-oss-20b MXFP4-Q8 on MLX (owner rule 1). One model loaded at a time; never push the machine to a crash.
- "Accuracy over completeness for measurements. A missing number is fine; a wrong number is not."
- Work on branch `v0.15.0-work`; never commit to `main`; never push unless asked.
- No `sudo` in anything that ships.
- Cost-aware delegation: do small work yourself; delegate to Cursor only for large work (owner, 2026-09-30; made global 2026-10-03). Cursor models: Composer or Grok only (2026-10-01).
- "Keep replies brief and in plain words." Status update every 45 minutes, even when idle.
- Live tests are on HOLD while the owner uses the Mac: do not load a model until told the hardware is free.

## Owner's additions, 2026-10-03 (verbatim list)
1. "Queque menages" (a message queue).
2. "More. Memory available for usage — also the context metric always seems to be Low, either its not calculated correctly or the agent doesn't hold context ..."
3. "instances where agent will attempt to start a task but will stop abruptly"
4. "Cli integration — essentially, a port or something for my cursor Agent to talk to Forge directly without the UI ... while retaining all the functionalities like the project memory chat sessions everything."
5. "Create a bridge for cursor and my local Agent, just like you have currently for Claude and cursor. In this case, Claude's role will be done by cursor and cursor role will be done by my local Agent."
6. "Robust grep tool to identify isolate specific items from the document or repo"
7. "update the repo according to my frameworks, but be very careful, dont break anything and do a git commit before you start, so we can revert back if anything breaks" (git tag `pre-frameworks-2026-10-03`).

Item 2's "More. Memory available for usage" half (show more memory information) is not yet done; only the context-meter bug was fixed. See `PROGRESS.md`.
