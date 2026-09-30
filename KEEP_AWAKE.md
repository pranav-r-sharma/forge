# Keeping the Mac awake during long agent runs

This note is for AI coding agents working on this Mac.

## Why this matters

Long background work (model tests, Cursor bridge tasks, scheduled status updates) can stop when macOS goes to idle sleep. On **2026-09-30** the Mac idle-slept at **08:50** (`pmset` log: *Entering Sleep state due to Idle Sleep*) because an earlier `caffeinate` had already exited. The system idle sleep setting is **1 minute**.

## Check current state

```bash
pmset -g assertions | grep -i caffeinate
pgrep -fl caffeinate
pmset -g log | grep -E " Sleep | Wake " | tail
pmset -g | grep -E "^ sleep"
```

## Keep awake (no sudo, user-level)

```bash
nohup caffeinate -ims -t 43200 >/dev/null 2>&1 & disown
```

- **-i** — prevent idle sleep  
- **-m** — prevent disk idle sleep  
- **-s** — prevent system sleep (only when on AC power)  
- **-t 43200** — run for 12 hours  

Use `nohup` and `disown` so the process survives when the agent shell ends. **Verify in a separate command:**

```bash
pgrep -fl caffeinate
```

## Stop

```bash
pkill caffeinate
```

## Limits

- The display can still turn off.
- Does not stop sleep on lid close, or on battery (`-s` needs AC).
- Does not survive reboot or logout.
- Do **not** change `pmset` settings (that needs sudo; project rule: read system limits, never change them).

## Tip

Scheduled agent updates cannot run while the Mac sleeps. Start `caffeinate` before long runs and note when it is set to end.
