import * as fs from 'fs';
import * as path from 'path';

/**
 * File mailbox so another agent (Cursor) can hand work to Forge.
 * Layout matches ~/.local/bin/bridge: <mailboxRoot>/inbox/<name>/*.md,
 * archive/, plus processing/ for the file currently being run.
 * This module is plain Node (fs/path only) so it can be tested without VS Code.
 */

export type BridgeMode = 'agent' | 'auto' | 'ask' | 'plan' | 'outcome';

const BRIDGE_MODES: readonly BridgeMode[] = ['agent', 'auto', 'ask', 'plan', 'outcome'];

export function isBridgeMode(value: string): value is BridgeMode {
  return (BRIDGE_MODES as readonly string[]).includes(value);
}

/** One claimed mail file, ready to run as a chat. `mode` is set from @mode, or from the default when this is a new chat. */
export interface BridgeTask {
  from: string;
  to: string;
  subject: string;
  sent: string;
  /** Body with leading @session / @mode lines removed. */
  text: string;
  sessionId?: string;
  mode?: BridgeMode;
}

export interface BridgeResult {
  ok: boolean;
  sessionId: string;
  finalText: string;
  error?: string;
}

export interface ParsedBridgeFile {
  from: string;
  to: string;
  subject: string;
  sent: string;
  text: string;
  sessionId?: string;
  mode?: BridgeMode;
}

export interface AgentBridgeOptions {
  /** Absolute or relative path of `<workspace>/.agent-bridge`. All reads and writes stay under this directory. */
  mailboxRoot: string;
  runner: (task: BridgeTask) => Promise<BridgeResult>;
  log?: (line: string) => void;
  /** How often to scan the inbox if a filesystem watch event is missed. */
  pollMs?: number;
  /** Used when the mail has no @mode line and no @session (a new chat). */
  defaultMode?: BridgeMode;
}

const MAX_BRIDGE_BYTES = 200 * 1024;

export function parseBridgeFile(raw: string): ParsedBridgeFile | undefined {
  const split = splitFrontmatter(raw);
  if (!split) return undefined;
  const directed = takeDirectives(split.body);
  return {
    from: split.attrs.from ?? '',
    to: split.attrs.to ?? '',
    subject: split.attrs.subject ?? '',
    sent: split.attrs.sent ?? '',
    text: directed.text,
    sessionId: directed.sessionId,
    mode: directed.mode,
  };
}

export function buildReply(opts: { to: string; subject: string; status: 'done' | 'error'; session: string; body: string; sent?: string }): string {
  const sent = opts.sent ?? formatSent(new Date());
  const subject = oneLine(opts.subject);
  const to = oneLine(opts.to);
  const session = oneLine(opts.session);
  return `---\nfrom: forge\nto: ${to}\nsubject: Re: ${subject}\nsent: ${sent}\nstatus: ${opts.status}\nsession: ${session}\n---\n\n${opts.body}`;
}

/** Single inbox folder name. `../../x` and anything with a slash become `unknown`, so a reply cannot leave the mailbox. */
export function sanitizeMailboxName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) return 'unknown';
  if (cleaned.includes('..')) return 'unknown';
  return cleaned;
}

/** Session ids are a single token (`sess_…`). Anything else is refused before it can be used as a file path. */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

export class AgentBridge {
  private readonly root: string;
  private readonly runner: (task: BridgeTask) => Promise<BridgeResult>;
  private readonly log?: (line: string) => void;
  private readonly pollMs: number;
  private defaultMode: BridgeMode;
  private stopped = true;
  private started = false;
  private draining = false;
  /** Set when rename-into-processing fails, so the loop waits for the next poll instead of spinning. */
  private claimFailed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private watcher: fs.FSWatcher | undefined;

  constructor(opts: AgentBridgeOptions) {
    // Canonicalize so a macOS /var -> /private/var prefix doesn't look like an escape
    // when we realpath a symlink target to decide whether it is safe to read.
    const resolved = path.resolve(opts.mailboxRoot);
    fs.mkdirSync(resolved, { recursive: true });
    this.root = fs.realpathSync(resolved);
    this.runner = opts.runner;
    this.log = opts.log;
    this.pollMs = opts.pollMs && opts.pollMs > 0 ? opts.pollMs : 2000;
    this.defaultMode = opts.defaultMode && isBridgeMode(opts.defaultMode) ? opts.defaultMode : 'agent';
  }

  setDefaultMode(mode: BridgeMode) {
    this.defaultMode = isBridgeMode(mode) ? mode : 'agent';
  }

  /** Move anything left in processing/ back to the inbox, then watch for new mail. */
  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.ensureDirs();
    this.recoverProcessing();
    this.armWatch();
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.kick();
  }

  /** Stop taking new files. A task already running is allowed to finish and reply. */
  stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      this.watcher?.close();
    } catch {
      /* already closed */
    }
    this.watcher = undefined;
  }

  dispose() {
    this.stop();
  }

  private kick() {
    if (this.stopped || this.draining) return;
    this.draining = true;
    void this.pump()
      .catch((err) => this.log?.(`bridge loop error: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.draining = false;
        if (!this.stopped && !this.claimFailed && this.pickNext()) this.kick();
      });
  }

  private async pump() {
    while (!this.stopped) {
      const next = this.pickNext();
      if (!next) return;
      const claimed = this.claim(next);
      if (!claimed) {
        this.claimFailed = true;
        return;
      }
      this.claimFailed = false;
      await this.runClaimed(claimed);
    }
  }

  /** Oldest filename first. Skips non-md, and leaves mail addressed to someone else sitting in the inbox. */
  private pickNext(): string | undefined {
    const dir = resolveInside(this.root, 'inbox', 'forge');
    if (!dir || !exists(dir)) return undefined;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
    } catch {
      return undefined;
    }
    for (const name of names) {
      const full = resolveInside(dir, name);
      if (!full) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) return full;
      if (!st.isFile()) continue;
      if (st.size > MAX_BRIDGE_BYTES) return full;
      let raw: string;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseBridgeFile(raw);
      if (parsed && parsed.to === 'forge') return full;
    }
    return undefined;
  }

  private async runClaimed(claimed: string) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(claimed);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BRIDGE_BYTES) {
      const meta = this.peekMeta(claimed, st.isSymbolicLink());
      const why = st.isSymbolicLink() ? 'Refusing to run a symlink.' : 'Refusing to run a file larger than 200KB.';
      this.writeReply(meta.from, meta.subject, 'error', '', why);
      this.archive(claimed);
      return;
    }
    const raw = fs.readFileSync(claimed, 'utf8');
    const parsed = parseBridgeFile(raw);
    if (!parsed || parsed.to !== 'forge') {
      this.returnToInbox(claimed);
      return;
    }
    if (parsed.sessionId && !isSafeSessionId(parsed.sessionId)) {
      this.writeReply(parsed.from, parsed.subject || 'task', 'error', '', 'Invalid @session id.');
      this.archive(claimed);
      return;
    }
    const task: BridgeTask = {
      from: parsed.from,
      to: 'forge',
      subject: parsed.subject,
      sent: parsed.sent,
      text: parsed.text,
      sessionId: parsed.sessionId,
      mode: parsed.mode ?? (parsed.sessionId ? undefined : this.defaultMode),
    };
    try {
      const result = await this.runner(task);
      if (result.ok) {
        this.writeReply(parsed.from, parsed.subject, 'done', result.sessionId || '', result.finalText ?? '');
      } else {
        this.writeReply(parsed.from, parsed.subject, 'error', result.sessionId || '', errorBody(result));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writeReply(parsed.from, parsed.subject, 'error', '', message);
    } finally {
      this.archive(claimed);
    }
  }

  /** Read just enough of a rejected file to know who to answer. Never follows a symlink that points outside the mailbox. */
  private peekMeta(file: string, link: boolean): { from: string; subject: string } {
    const fallback = { from: 'unknown', subject: path.basename(file, '.md') || 'task' };
    try {
      if (link) {
        const real = fs.realpathSync(file);
        if (!isInside(this.root, real)) return fallback;
      }
      const head = readHead(file, 8192);
      const parsed = parseBridgeFile(head);
      if (!parsed) return fallback;
      return { from: parsed.from || 'unknown', subject: parsed.subject || fallback.subject };
    } catch {
      return fallback;
    }
  }

  private writeReply(fromRaw: string, subject: string, status: 'done' | 'error', session: string, body: string) {
    try {
      const to = sanitizeMailboxName(fromRaw);
      const dir = resolveInside(this.root, 'inbox', to);
      if (!dir) {
        this.log?.('refusing reply outside mailbox');
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      const base = `${fileStamp(new Date())}-forge-${slugifySubject(subject)}`;
      let name = `${base}.md`;
      let i = 2;
      while (exists(path.join(dir, name))) {
        name = `${base}-${i}.md`;
        i++;
        if (i > 1000) return;
      }
      const dest = resolveInside(dir, name);
      if (!dest) return;
      const tmp = `${dest}.tmp`;
      if (!isInside(this.root, tmp)) return;
      fs.writeFileSync(tmp, buildReply({ to, subject: subject || 'task', status, session, body }), 'utf8');
      fs.renameSync(tmp, dest);
    } catch (err) {
      this.log?.(`reply failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private claim(src: string): string | undefined {
    if (!isInside(this.root, src)) return undefined;
    const dir = resolveInside(this.root, 'processing');
    if (!dir) return undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(src);
      let dest = path.join(dir, name);
      let i = 2;
      while (exists(dest)) {
        dest = path.join(dir, `${name.replace(/\.md$/, '')}-${i}.md`);
        i++;
      }
      if (!isInside(this.root, dest)) return undefined;
      fs.renameSync(src, dest);
      return dest;
    } catch {
      return undefined;
    }
  }

  private archive(src: string) {
    const dir = resolveInside(this.root, 'archive');
    if (!dir || !isInside(this.root, src)) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(src);
      let dest = path.join(dir, name);
      let i = 2;
      while (exists(dest)) {
        dest = path.join(dir, `${name.replace(/\.md$/, '')}-${i}.md`);
        i++;
      }
      fs.renameSync(src, dest);
    } catch (err) {
      this.log?.(`archive failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private returnToInbox(src: string) {
    const dir = resolveInside(this.root, 'inbox', 'forge');
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, path.basename(src));
      let i = 2;
      while (exists(dest)) {
        dest = path.join(dir, `${path.basename(src, '.md')}-${i}.md`);
        i++;
      }
      fs.renameSync(src, dest);
    } catch (err) {
      this.log?.(`return to inbox failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private recoverProcessing() {
    const processing = resolveInside(this.root, 'processing');
    const inbox = resolveInside(this.root, 'inbox', 'forge');
    if (!processing || !inbox || !exists(processing)) return;
    fs.mkdirSync(inbox, { recursive: true });
    let names: string[] = [];
    try {
      names = fs.readdirSync(processing);
    } catch {
      return;
    }
    for (const name of names) {
      const src = resolveInside(processing, name);
      if (!src) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(src);
      } catch {
        continue;
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      let dest = path.join(inbox, name);
      let i = 2;
      while (exists(dest)) {
        dest = path.join(inbox, `${name.replace(/\.md$/, '')}-${i}.md`);
        i++;
      }
      try {
        fs.renameSync(src, dest);
        this.log?.(`requeued ${name} left in processing/`);
      } catch (err) {
        this.log?.(`requeue failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private ensureDirs() {
    for (const parts of [
      ['inbox', 'forge'],
      ['processing'],
      ['archive'],
    ]) {
      const dir = resolveInside(this.root, ...parts);
      if (dir) fs.mkdirSync(dir, { recursive: true });
    }
  }

  private armWatch() {
    const dir = resolveInside(this.root, 'inbox', 'forge');
    if (!dir) return;
    try {
      this.watcher = fs.watch(dir, () => this.kick());
      this.watcher.on('error', () => {
        /* poll still scans */
      });
    } catch (err) {
      this.log?.(`watch failed, polling only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function splitFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const attrs: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    attrs[kv[1]] = kv[2].trim();
  }
  return { attrs, body: match[2] };
}

function takeDirectives(body: string): { text: string; sessionId?: string; mode?: BridgeMode } {
  const lines = body.split(/\r?\n/);
  let i = 0;
  let sessionId: string | undefined;
  let mode: BridgeMode | undefined;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '') {
      i++;
      continue;
    }
    const sess = /^@session\s+(\S+)$/.exec(line);
    if (sess) {
      sessionId = sess[1];
      i++;
      continue;
    }
    const md = /^@mode\s+(\S+)$/.exec(line);
    if (md && isBridgeMode(md[1])) {
      mode = md[1];
      i++;
      continue;
    }
    break;
  }
  return { text: lines.slice(i).join('\n').replace(/^\n/, ''), sessionId, mode };
}

function errorBody(result: BridgeResult): string {
  const bits: string[] = [];
  const text = (result.finalText || '').trim();
  const err = (result.error || '').trim();
  if (text) bits.push(text);
  if (err && err !== text) bits.push(err);
  return bits.join('\n\n') || 'The task failed.';
}

function slugifySubject(subject: string): string {
  const slug = subject.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40);
  return slug || 'task';
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function formatSent(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function resolveInside(root: string, ...parts: string[]): string | undefined {
  const resolved = path.resolve(root, ...parts);
  return isInside(root, resolved) ? resolved : undefined;
}

function readHead(file: string, max: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}
