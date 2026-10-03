# Delegating work to Forge

Forge can take a task from Cursor through a folder of mail files, `.agent-bridge/`. This is the same idea as the Claude-to-Cursor bridge. Forge's mailbox name is `forge`. Cursor's is `cursor`.

## When to use it

Use it when you want the local Forge agent to do a real coding job in this workspace: several files, a long agent loop, work that should show up in Forge's chat history, memory, and project log.

Do small, quick work yourself (a one-line edit, git status, reading a file).

## What has to be running

- VS Code is open on this workspace.
- The Forge extension is running.
- `forge.bridge.enabled` is true. It defaults to **false** on purpose: anyone who can write files in the repo could otherwise start the agent.
- `forge.bridge.defaultMode` is the mode for a new chat when the task does not name one. Default is `agent`.

Closing VS Code stops the bridge. Opening it again with the setting still on starts it again. The status bar shows "Forge bridge listening" while it is on.

## How to send a task

From the repo (or any folder inside it):

```bash
_devtools/bridge/forge-bridge ask "Short subject" "What you want done."
```

Options:

- `--session ID` — continue that Forge chat instead of starting a new one
- `--mode agent|auto|ask|plan|outcome`
- `--timeout 3600` — seconds to wait for the reply (default 3600)

Exit codes: `0` done, `1` error, `2` timed out.

The same mail format as the other bridge also works. No change to that script is required:

```bash
bridge send cursor forge "Short subject" "What you want done."
```

Then read the answer with `bridge read cursor`.

You can put directives on their own lines at the top of the body. The helper writes these for you when you pass the flags:

```
@session sess_abc_1
@mode plan
```

`@session` without `@mode` keeps that chat's current mode. A new chat with no `@mode` uses `forge.bridge.defaultMode`.

## What you get back

Forge writes the reply to `.agent-bridge/inbox/cursor/`. The helper prints it and moves it to `.agent-bridge/archive/`. The original task is archived too.

Each reply has frontmatter: `from: forge`, `to: cursor`, `subject: Re: …`, `status: done` or `error`, and `session` (the Forge chat id, so you can pass it to `--session` next time).

`forge-bridge status` lists anything waiting in `inbox/forge` or `processing/`.

If VS Code quits while a task is running, the file sits in `.agent-bridge/processing/`. The next time the bridge starts, it moves that file back to the inbox and runs it again.

## How the task actually runs

It is a normal Forge chat, titled `[bridge] <subject>`. Same tools, memory, project log, and history as if you had typed it in the panel.

Approvals are not skipped. If a command or an edit needs approval, the task waits in the Forge panel until you answer. The helper keeps waiting until then, or until `--timeout`.

If that chat is already busy, the reply text is:

`Queued: the chat was busy; it will be handled in that session.`

That means the message is waiting in the chat. It does not mean the work is finished.

## Limits

- One task at a time, oldest file first.
- Mail larger than 200KB is not run (you get an error reply).
- Symlinks are not run.
- Files whose `to:` is not `forge` are left in the inbox.
- A `from:` name that tries to climb out of the mailbox (for example `../../x`) is rewritten so the reply stays inside `.agent-bridge/`.
- The bridge does nothing until `forge.bridge.enabled` is true, and only while VS Code is open on a workspace folder.
