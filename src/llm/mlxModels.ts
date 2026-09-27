import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface MlxLocalModel {
  /** Hugging Face repo id (org/name) for cache entries, else the absolute model folder path. */
  id: string;
  /** Resolved snapshot or folder directory. */
  dir: string;
  sizeBytes: number;
  source: 'library' | 'extra';
}

/** Expands a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  const t = (p || '').trim();
  if (t === '~') return os.homedir();
  if (t.startsWith('~/')) return path.join(os.homedir(), t.slice(2));
  return t;
}

/**
 * Resolves the MLX model library root from settings / environment.
 * Empty setting → $HF_HUB_CACHE, else $HF_HOME/hub, else ~/.cache/huggingface/hub.
 */
export function resolveModelLibraryPath(setting: string): string {
  const s = (setting || '').trim();
  if (s) return expandTilde(s);
  if (process.env.HF_HUB_CACHE) return expandTilde(process.env.HF_HUB_CACHE);
  if (process.env.HF_HOME) return path.join(expandTilde(process.env.HF_HOME), 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

function sumSafetensorsBytes(dir: string): number {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.safetensors'))
      .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  } catch {
    return 0;
  }
}

function hasWeights(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'config.json')) && fs.readdirSync(dir).some((f) => f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

function parseRepoFromCacheDirName(folderName: string): { org: string; name: string } | undefined {
  if (!folderName.startsWith('models--')) return undefined;
  const rest = folderName.slice('models--'.length);
  const i = rest.indexOf('--');
  if (i <= 0) return undefined;
  return { org: rest.slice(0, i), name: rest.slice(i + 2) };
}

function readConfig(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** MLX-only filter: quantized MLX config, mlx-community org, or "mlx" in the repo name. */
export function isMlxModelDir(dir: string, org?: string, repoName?: string): boolean {
  if (!hasWeights(dir)) return false;
  const cfg = readConfig(dir);
  if (cfg && typeof cfg.quantization === 'object' && cfg.quantization !== null) {
    const q = cfg.quantization as Record<string, unknown>;
    if (typeof q.bits === 'number' || typeof q.group_size === 'number') return true;
  }
  if (org === 'mlx-community') return true;
  if (repoName && /mlx/i.test(repoName)) return true;
  return false;
}

function pickSnapshot(repoDir: string, org: string, name: string): string | undefined {
  const snapshotsDir = path.join(repoDir, 'snapshots');
  try {
    const refsMain = path.join(repoDir, 'refs', 'main');
    if (fs.existsSync(refsMain)) {
      const hash = fs.readFileSync(refsMain, 'utf8').trim();
      if (hash) {
        const snap = path.join(snapshotsDir, hash);
        if (isMlxModelDir(snap, org, name)) return snap;
      }
    }
  } catch {
    /* skip */
  }
  try {
    const dirs = fs
      .readdirSync(snapshotsDir)
      .map((d) => path.join(snapshotsDir, d))
      .filter((d) => isMlxModelDir(d, org, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0];
  } catch {
    return undefined;
  }
}

function scanHfCache(libraryPath: string, out: MlxLocalModel[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(libraryPath);
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.startsWith('models--')) continue;
    const repo = parseRepoFromCacheDirName(ent);
    if (!repo) continue;
    const repoDir = path.join(libraryPath, ent);
    const snap = pickSnapshot(repoDir, repo.org, repo.name);
    if (!snap) continue;
    out.push({
      id: `${repo.org}/${repo.name}`,
      dir: path.resolve(snap),
      sizeBytes: sumSafetensorsBytes(snap),
      source: 'library',
    });
  }
}

function scanPlainFolders(root: string, source: 'library' | 'extra', maxDepth: number, out: MlxLocalModel[]): void {
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) return;
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (depth >= 1 && hasWeights(dir) && isMlxModelDir(dir)) {
      const resolved = path.resolve(dir);
      out.push({ id: resolved, dir: resolved, sizeBytes: sumSafetensorsBytes(dir), source });
      return;
    }
    if (depth < maxDepth) {
      for (const n of names) {
        if (n === 'snapshots' || n === 'refs' || n.startsWith('models--')) continue;
        walk(path.join(dir, n), depth + 1);
      }
    }
  };
  walk(root, 0);
}

/** Lists MLX models under the library path and optional extra folders. Never throws. */
export function listLocalMlxModels(libraryPath: string, extraFolders: string[]): MlxLocalModel[] {
  const lib = expandTilde(libraryPath);
  const extras = extraFolders.map(expandTilde);
  const raw: MlxLocalModel[] = [];
  scanHfCache(lib, raw);
  scanPlainFolders(lib, 'library', 2, raw);
  for (const ex of extras) scanPlainFolders(ex, 'extra', 2, raw);
  const byDir = new Map<string, MlxLocalModel>();
  for (const m of raw) byDir.set(m.dir, m);
  return [...byDir.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface ResolveModelPathOptions {
  /** Raw setting value; expanded via resolveModelLibraryPath when not overridden by libraryPath. */
  libraryPathSetting?: string;
  /** Explicit hub root (tests); bypasses setting/env resolution. */
  libraryPath?: string;
  extraFolders?: string[];
}

function libraryRoot(opts?: string | ResolveModelPathOptions): { lib: string; extra: string[] } {
  if (typeof opts === 'string') return { lib: opts, extra: [] };
  const o = opts ?? {};
  const lib = o.libraryPath ?? resolveModelLibraryPath(o.libraryPathSetting ?? '');
  const extra = (o.extraFolders ?? []).map(expandTilde);
  return { lib, extra };
}

function findInExtraByRepoName(extraFolders: string[], repoName: string): string | undefined {
  for (const root of extraFolders) {
    let found: string | undefined;
    const walk = (dir: string, depth: number) => {
      if (found || depth > 2) return;
      let names: string[];
      try {
        if (!fs.statSync(dir).isDirectory()) return;
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      if (path.basename(dir) === repoName && isMlxModelDir(dir)) {
        found = path.resolve(dir);
        return;
      }
      if (depth < 2) for (const n of names) walk(path.join(dir, n), depth + 1);
    };
    walk(root, 0);
    if (found) return found;
  }
  return undefined;
}

function hfSnapshotForRepo(lib: string, repoId: string): string | undefined {
  const repo = parseRepoFromCacheDirName(`models--${repoId.replace('/', '--')}`);
  if (!repo) return undefined;
  const repoDir = path.join(lib, `models--${repo.org}--${repo.name}`);
  const snap = pickSnapshot(repoDir, repo.org, repo.name);
  return snap ? path.resolve(snap) : undefined;
}

/** Folders that were consulted while resolving a model (for error messages). */
export function searchedFoldersForResolve(lib: string, extra: string[]): string[] {
  return [lib, ...extra];
}

export function formatModelNotFoundMessage(model: string, lib: string, extra: string[], found: MlxLocalModel[]): string {
  const searched = searchedFoldersForResolve(lib, extra);
  const ids = found.map((m) => m.id).slice(0, 10);
  const lines = [
    `MLX model "${model.trim()}" was not found locally. Forge runs the MLX server offline and never downloads models by itself.`,
    `Searched: ${searched.join(', ')}`,
  ];
  if (ids.length) {
    lines.push(`MLX models found there (up to 10): ${ids.join(', ')}`);
    lines.push('To fix: pick one with "Forge: Select Chat Model", or set forge.mlx.modelLibraryPath / forge.mlx.extraModelFolders to where this Mac keeps models.');
  } else {
    lines.push('No MLX models were found in those folders.');
    lines.push('To fix: download a model, set forge.mlx.modelLibraryPath / forge.mlx.extraModelFolders, then use "Forge: Select Chat Model".');
  }
  return lines.join(' ');
}

/**
 * Resolves a local model folder or Hugging Face repo id to a snapshot directory. Never downloads.
 * Second argument may be a hub root string (tests) or options with library path + extra folders.
 */
export function resolveModelPath(model: string, opts?: string | ResolveModelPathOptions): string {
  const m = (model || '').trim();
  if (!m) throw new Error('No MLX model is configured. Set forge.mlx.model to a local model folder or a Hugging Face repo id (e.g. "ornith-ai/Ornith-1.5-9B-MLX-4bit") that is already downloaded.');
  const { lib, extra } = libraryRoot(opts);
  if (hasWeights(m) && isMlxModelDir(m)) return path.resolve(m);
  if (/^[\w.-]+\/[\w.-]+$/.test(m)) {
    const fromLib = hfSnapshotForRepo(lib, m);
    if (fromLib) return fromLib;
    const namePart = m.split('/').slice(1).join('/');
    const fromExtra = findInExtraByRepoName(extra, namePart);
    if (fromExtra) return fromExtra;
  }
  const found = listLocalMlxModels(lib, extra);
  throw new Error(formatModelNotFoundMessage(m, lib, extra, found));
}
