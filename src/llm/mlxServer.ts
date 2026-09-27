import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OllamaPsModel } from '../ollama/types';
import { expandTilde, resolveModelPath as resolveModelPathImpl, type ResolveModelPathOptions } from './mlxModels';

export { resolveModelPath } from './mlxModels';
export type { ResolveModelPathOptions } from './mlxModels';

/**
 * Lifecycle manager for a local `mlx_lm.server` (v0.15.0 Phase 0 §0.1c). Forge starts it when MLX is the chosen runtime, waits until it is healthy,
 * restarts it when the model/port changes, and stops it on exit — so nobody has to run a Python command by hand.
 *
 * Safety rules baked in (owner directives): the server only ever binds 127.0.0.1; it runs OFFLINE (HF_HUB_OFFLINE=1 — it never downloads anything on
 * its own); `--trust-remote-code` is refused; it is a user-level process (no sudo); and a model is not loaded if free memory can't hold it.
 * If something healthy is already answering on the port (e.g. the user started a server themselves) it is adopted and never killed.
 */

export type MlxState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'stopping';

export interface MlxServerConfig {
  /** Python interpreter that has mlx-lm installed. */
  pythonPath: string;
  /** Local model directory, or a Hugging Face repo id already present in the local cache. */
  model: string;
  port: number;
  /** Cap for the server's in-memory prompt cache, bytes (0/undefined = the server's default). */
  promptCacheBytes?: number;
  extraArgs?: string[];
  startupTimeoutMs?: number;
}

export class MlxServerError extends Error {
  constructor(message: string, public readonly logTail: string[] = []) {
    super(message);
    this.name = 'MlxServerError';
  }
}

const REFUSED_EXTRA_ARGS = ['--trust-remote-code', '--host', '--port', '--model'];

/** Builds the argv for `python -m mlx_lm.server`. Pure. Throws if extra args try to weaken a safety rule or override a managed option. */
export function buildServerArgs(cfg: Pick<MlxServerConfig, 'port' | 'promptCacheBytes' | 'extraArgs'>, resolvedModel: string): string[] {
  for (const a of cfg.extraArgs || []) {
    const flag = a.split('=')[0];
    if (REFUSED_EXTRA_ARGS.includes(flag)) throw new MlxServerError(`forge.mlx.extraArgs may not contain "${flag}" — Forge manages the model, host (127.0.0.1 only) and port itself, and never enables remote code.`);
  }
  const args = ['-m', 'mlx_lm.server', '--model', resolvedModel, '--host', '127.0.0.1', '--port', String(cfg.port), '--log-level', 'WARNING'];
  if (cfg.promptCacheBytes && cfg.promptCacheBytes > 0) args.push('--prompt-cache-bytes', String(Math.floor(cfg.promptCacheBytes)));
  return [...args, ...(cfg.extraArgs || [])];
}

/** Wraps mlxModels.resolveModelPath and maps failures to MlxServerError. */
function resolveModelForServer(model: string, opts?: ResolveModelPathOptions): string {
  try {
    return resolveModelPathImpl(model, opts);
  } catch (e: any) {
    throw new MlxServerError(e?.message || String(e));
  }
}

/** Total size of the weights files, bytes (for the free-memory check). */
export function modelWeightsBytes(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.safetensors')).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  } catch {
    return 0;
  }
}

/** Minimal shape of the child process we use — lets tests substitute a fake. */
export interface ChildLike {
  pid?: number;
  stdout?: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown } | null;
  stderr?: { on(ev: 'data', cb: (d: Buffer | string) => void): unknown } | null;
  on(ev: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(ev: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface MlxServerDeps {
  spawn?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: any }) => ChildLike;
  /** True when `http://127.0.0.1:port/health` answers OK. */
  isHealthy?: (port: number) => Promise<boolean>;
  /** Free memory available for the model, GB, or undefined if unknown (then the check is skipped, never guessed). */
  availableGB?: () => Promise<number | undefined>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  pollMs?: number;
  /** Read on each ensure() so live settings edits apply. */
  mlxModelPathContext?: () => { libraryPathSetting: string; extraFolders: string[] };
  /** How many times to probe before concluding the port is free rather than just slow to answer (default 3). */
  adoptProbeAttempts?: number;
}

const defaultIsHealthy = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
};

export class MlxServerManager {
  private child: ChildLike | undefined;
  private external = false;
  private _state: MlxState = 'stopped';
  private _error: string | undefined;
  private key: string | undefined;
  private resolvedModel: string | undefined;
  private modelBytes = 0;
  /** True while Forge itself is terminating the child, so its exit is not mistaken for a crash. */
  private intentionalKill = false;
  private chain: Promise<unknown> = Promise.resolve();
  private lines: string[] = [];
  private listeners = new Set<(s: MlxState) => void>();

  constructor(private readonly deps: MlxServerDeps = {}) {}

  get state(): MlxState {
    return this._state;
  }
  get lastError(): string | undefined {
    return this._error;
  }
  /** Last ~200 lines of the server's own output, for error messages. */
  logTail(n = 20): string[] {
    return this.lines.slice(-n);
  }
  onState(cb: (s: MlxState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private set(s: MlxState) {
    this._state = s;
    for (const l of [...this.listeners]) {
      try { l(s); } catch { /* listeners must not break the manager */ }
    }
  }
  private log(line: string) {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    try { this.deps.log?.(line); } catch { /* ignore */ }
  }

  /** What is resident, for `ps()` / the hardware readout. */
  resident(): OllamaPsModel[] {
    if (this._state !== 'ready' || !this.resolvedModel) return [];
    const name = path.basename(path.dirname(path.dirname(this.resolvedModel))).replace(/^models--/, '').replace('--', '/') || path.basename(this.resolvedModel);
    return [{ name, model: name, size: this.modelBytes }];
  }

  /** Several tries, `pollMs` apart (default 3), before concluding a port is actually free rather than just slow to answer right now. */
  private async probeAdopt(port: number, isHealthy: (port: number) => Promise<boolean>): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = this.deps.pollMs ?? 500;
    const attempts = this.deps.adoptProbeAttempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await isHealthy(port)) return true;
      if (attempt < attempts - 1) await sleep(pollMs);
    }
    return false;
  }

  /** Makes sure a healthy server for exactly this config is running; starts, restarts or adopts as needed. Calls are serialized. */
  ensure(cfg: MlxServerConfig): Promise<void> {
    const run = this.chain.then(() => this.doEnsure(cfg));
    this.chain = run.catch(() => undefined);
    return run;
  }

  stop(): Promise<void> {
    const run = this.chain.then(() => this.doStop());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doEnsure(cfg: MlxServerConfig): Promise<void> {
    const isHealthy = this.deps.isHealthy ?? defaultIsHealthy;
    const ctx = this.deps.mlxModelPathContext?.() ?? { libraryPathSetting: '', extraFolders: [] };
    const resolved = resolveModelForServer(cfg.model, {
      libraryPathSetting: ctx.libraryPathSetting,
      extraFolders: ctx.extraFolders,
    });
    const key = JSON.stringify([cfg.pythonPath, resolved, cfg.port, cfg.promptCacheBytes ?? 0, cfg.extraArgs ?? []]);
    if (this._state === 'ready' && this.key === key && (this.external || (this.child && (await isHealthy(cfg.port))))) return;
    if (this._state !== 'stopped') await this.doStop(); // config changed or previous run died: start clean
    this._error = undefined;

    // adopt something already serving on this port (e.g. started by the user, or a leftover process from an earlier run)
    // instead of fighting for it. Retry the check briefly first: a real server can be slow to answer under load, and a
    // single failed probe must never be mistaken for "the port is free" — that mistake spawns a second process straight
    // into an EADDRINUSE crash instead of adopting the one already there.
    if (await this.probeAdopt(cfg.port, isHealthy)) {
      this.external = true;
      this.key = key;
      this.resolvedModel = resolved;
      this.modelBytes = modelWeightsBytes(resolved);
      this.log(`[forge] adopting the MLX server already running on 127.0.0.1:${cfg.port} (not managed by Forge; it will not be stopped)`);
      this.set('ready');
      return;
    }

    const args = buildServerArgs(cfg, resolved); // throws on unsafe extra args
    const need = modelWeightsBytes(resolved) / 1024 ** 3;
    const avail = await (this.deps.availableGB?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    if (avail !== undefined && need > 0 && avail < need * 1.15 + 1.5) {
      throw new MlxServerError(`Not enough free memory to load this model safely: it needs about ${need.toFixed(1)} GB plus working space, and only ${avail.toFixed(1)} GB is available. Close other apps or choose a smaller / more heavily quantized model (e.g. 4-bit).`);
    }

    this.external = false;
    this.key = key;
    this.resolvedModel = resolved;
    this.modelBytes = modelWeightsBytes(resolved);
    this.set('starting');
    const spawn = this.deps.spawn ?? ((c, a, o) => childProcess.spawn(c, a, o as any) as unknown as ChildLike);
    this.log(`[forge] starting: ${cfg.pythonPath} ${args.join(' ')}`);
    let child: ChildLike;
    try {
      child = spawn(cfg.pythonPath, args, { env: { ...process.env, HF_HUB_OFFLINE: '1', PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      this.set('crashed');
      this._error = `Could not start ${cfg.pythonPath}: ${err?.message || err}`;
      throw new MlxServerError(this._error);
    }
    this.child = child;
    let exited: { code: number | null; signal: string | null } | undefined;
    let spawnError: Error | undefined;
    const feed = (d: Buffer | string) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => this.log(l));
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (e) => { spawnError = e; });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (this.child === child) {
        this.child = undefined;
        if (!this.intentionalKill && this._state !== 'stopping' && this._state !== 'stopped') {
          this._error = `The MLX server exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''}).`;
          this.log(`[forge] ${this._error}`);
          this.set('crashed');
        }
      }
    });

    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (cfg.startupTimeoutMs ?? 180_000);
    const pollMs = this.deps.pollMs ?? 500;
    for (;;) {
      if (spawnError || exited) {
        const why = spawnError ? `could not be launched: ${spawnError.message}` : `exited during start-up (code ${exited!.code})`;
        this._error = `The MLX server ${why}.`;
        this.set('crashed');
        throw new MlxServerError(`${this._error} Last output:\n${this.logTail(12).join('\n')}`, this.logTail(12));
      }
      if (await isHealthy(cfg.port)) break;
      if (Date.now() > deadline) {
        this._error = `The MLX server did not become ready within ${Math.round((cfg.startupTimeoutMs ?? 180_000) / 1000)} s.`;
        await this.killChild();
        this.set('crashed');
        throw new MlxServerError(`${this._error} Last output:\n${this.logTail(12).join('\n')}`, this.logTail(12));
      }
      await sleep(pollMs);
    }
    this.log('[forge] MLX server is ready');
    this.set('ready');
  }

  private async doStop(): Promise<void> {
    if (this._state === 'stopped' && !this.child) return;
    this.set('stopping');
    if (!this.external) await this.killChild();
    this.child = undefined;
    this.external = false;
    this.key = undefined;
    this.resolvedModel = undefined;
    this.set('stopped');
  }

  /** SIGTERM, then SIGKILL after a grace period. Never throws. */
  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    let done = false;
    child.on('exit', () => { done = true; });
    this.intentionalKill = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const grace = this.deps.killGraceMs ?? 5000;
    const step = Math.max(10, Math.min(100, grace / 10));
    for (let waited = 0; !done && waited < grace; waited += step) await sleep(step);
    if (!done) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    this.child = undefined;
    this.intentionalKill = false;
  }

  dispose(): void {
    if (this.child && !this.external) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

/** Which interpreter to run the MLX server with: the configured one, else Forge's own venv (~/.forge/mlx-venv) if it exists, else `python3`. Pure given its inputs. */
export function resolvePython(configured: string, exists: (p: string) => boolean = fs.existsSync, home: string = os.homedir()): string {
  const c = (configured || '').trim();
  if (c) return c;
  const own = path.join(home, '.forge', 'mlx-venv', 'bin', 'python');
  return exists(own) ? own : 'python3';
}

/** Port and whether the URL points at THIS machine (Forge only spawns/manages a server it can bind on loopback; a remote URL is used as-is). */
export function parseLocalServerUrl(baseUrl: string): { port: number; isLoopback: boolean } | undefined {
  try {
    const u = new URL(baseUrl);
    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return Number.isFinite(port) ? { port, isLoopback } : undefined;
  } catch {
    return undefined;
  }
}

/** The settings the ensure-function needs (a slice of ForgeConfig, so it is testable without vscode). */
export interface MlxEnsureConfig {
  provider: string;
  mlxBaseUrl: string;
  mlxModel: string;
  mlxPythonPath: string;
  mlxAutoStart: boolean;
  mlxPromptCacheGB: number;
  mlxExtraArgs: string[];
  mlxModelLibraryPath?: string;
  mlxExtraModelFolders?: string[];
}

/**
 * Builds the "make sure MLX is ready" function the provider awaits before using MLX. Decisions:
 *  - not on MLX, or autoStart off, or the URL is not this machine → do nothing (a remote/other server is used as-is);
 *  - no model configured → don't manage anything; if a server is already healthy on the port (user-started) that is fine, otherwise explain what to set;
 *  - otherwise start/restart/adopt via the manager for exactly the current settings.
 */
export function makeEnsureMlx(
  getCfg: () => MlxEnsureConfig,
  manager: Pick<MlxServerManager, 'ensure'>,
  isHealthy: (port: number) => Promise<boolean> = defaultIsHealthy,
  python: (configured: string) => string = resolvePython
): () => Promise<void> {
  return async () => {
    const c = getCfg();
    if (c.provider !== 'mlx' || !c.mlxAutoStart) return;
    const u = parseLocalServerUrl(c.mlxBaseUrl);
    if (!u || !u.isLoopback) return;
    if (!c.mlxModel) {
      if (await isHealthy(u.port)) return;
      throw new MlxServerError('No MLX model is configured and no MLX server is running. Set forge.mlx.model to a downloaded model (a folder or a Hugging Face repo id like "ornith-ai/Ornith-1.5-9B-MLX-4bit"), or start mlx_lm.server yourself.');
    }
    await manager.ensure({
      pythonPath: python(c.mlxPythonPath),
      model: c.mlxModel,
      port: u.port,
      promptCacheBytes: c.mlxPromptCacheGB > 0 ? Math.floor(c.mlxPromptCacheGB * 1024 ** 3) : undefined,
      extraArgs: c.mlxExtraArgs,
    });
  };
}
