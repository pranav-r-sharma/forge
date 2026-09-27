import * as childProcess from 'child_process';
import * as os from 'os';

/**
 * Accurate hardware readout (v0.15.0 plan §1.4). Design rules, in priority order:
 *   1. Accuracy over completeness — when a source can't be read or parsed, the value is `undefined` (shown as "n/a"), never a plausible-looking guess.
 *   2. Only unprivileged sources (sysctl, vm_stat, ioreg, ps) — nothing here may ever need sudo.
 *   3. Parsers are pure functions over text so they can be tested against recorded fixtures; the exec layer is thin and injectable.
 *
 * Why this exists: `os.totalmem() - os.freemem()` (what getRamStatus() in hwMetrics.ts does) counts only never-touched pages as free, so on macOS it
 * reports reclaimable cache and idle memory as "used" — measured 21.8 GB "used" on a machine whose Activity Monitor said 9.7 GB.
 */

export type MemoryPressure = 'normal' | 'warn' | 'critical' | 'unknown';

export interface MemorySample {
  /** Physical memory, GB (2^30 bytes). */
  totalGB: number;
  /** Activity Monitor's "Memory Used": app (anonymous minus purgeable) + wired + compressed. */
  usedGB: number;
  /** total − used: what new work can use without forcing the OS to evict live app/wired memory. */
  availableGB: number;
  /** File cache + purgeable pages: reclaimable, so counted as available, not used. */
  cachedGB: number;
  /** Pages that are truly unused right now (a subset of available). */
  freeGB: number;
  wiredGB: number;
  compressedGB: number;
  swapUsedGB?: number;
  swapTotalGB?: number;
  /** macOS's own memory-pressure state (normal/warn/critical) — the honest "am I in trouble" signal. */
  pressure: MemoryPressure;
  /** kern.memorystatus_level (0-100). Informational only: it is a pressure heuristic, NOT free memory — never present it as such. */
  pressureLevelPct?: number;
  /** Bytes per page as reported by vm_stat's own header (16384 on Apple silicon). Never assumed. */
  pageSize?: number;
  /** 'darwin' = exact Activity-Monitor-style numbers; 'approximate' = non-macOS fallback via Node's os module (used/available are rough). */
  source: 'darwin' | 'approximate';
  tsMs: number;
}

const GB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Parses `vm_stat`. Requires the "page size of N bytes" header — returns undefined without it rather than assuming 4096 (Apple silicon uses 16384). */
export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } | undefined {
  const header = /page size of (\d+) bytes/i.exec(text || '');
  if (!header) return undefined;
  const pageSize = Number(header[1]);
  if (!Number.isFinite(pageSize) || pageSize < 1024 || pageSize > 1 << 20) return undefined;
  const pages: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^"?([^":]+?)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages[m[1].trim()] = Number(m[2]);
  }
  return { pageSize, pages };
}

/** Parses `sysctl -n vm.swapusage`, e.g. "total = 2048.00M  used = 828.38M  free = 1219.62M  (encrypted)". Returns GB. */
export function parseSwapUsage(text: string): { totalGB: number; usedGB: number } | undefined {
  const unit = (v: string, u: string) => Number(v) * (u === 'G' ? 1024 : u === 'K' ? 1 / 1024 : 1) / 1024; // → GB
  const total = /total\s*=\s*([\d.]+)([KMG])/i.exec(text || '');
  const used = /used\s*=\s*([\d.]+)([KMG])/i.exec(text || '');
  if (!total || !used) return undefined;
  return { totalGB: unit(total[1], total[2].toUpperCase()), usedGB: unit(used[1], used[2].toUpperCase()) };
}

/** kern.memorystatus_vm_pressure_level: 1 = normal, 2 = warn, 4 = critical. */
export function parsePressureLevel(text: string): MemoryPressure {
  const n = Number((text || '').trim());
  return n === 1 ? 'normal' : n === 2 ? 'warn' : n === 4 ? 'critical' : 'unknown';
}

/**
 * Activity-Monitor-style memory accounting from vm_stat. Returns undefined (→ "n/a") if any required counter is missing or the totals are
 * implausible (used > total) — a wrong number is worse than no number.
 */
export function computeMemory(totalBytes: number, vm: { pageSize: number; pages: Record<string, number> }): Pick<MemorySample, 'totalGB' | 'usedGB' | 'availableGB' | 'cachedGB' | 'freeGB' | 'wiredGB' | 'compressedGB' | 'pageSize'> | undefined {
  const p = vm.pages;
  const need = ['Pages free', 'Pages wired down', 'Pages purgeable', 'File-backed pages', 'Anonymous pages', 'Pages occupied by compressor'];
  if (!totalBytes || totalBytes <= 0 || need.some((k) => typeof p[k] !== 'number')) return undefined;
  const ps = vm.pageSize;
  const appPages = Math.max(0, p['Anonymous pages'] - p['Pages purgeable']);
  const usedBytes = (appPages + p['Pages wired down'] + p['Pages occupied by compressor']) * ps;
  if (usedBytes > totalBytes * 1.02) return undefined;
  const used = Math.min(usedBytes, totalBytes);
  return {
    totalGB: round1(totalBytes / GB),
    usedGB: round1(used / GB),
    availableGB: round1((totalBytes - used) / GB),
    cachedGB: round1(((p['File-backed pages'] + p['Pages purgeable']) * ps) / GB),
    freeGB: round1((p['Pages free'] * ps) / GB),
    wiredGB: round1((p['Pages wired down'] * ps) / GB),
    compressedGB: round1((p['Pages occupied by compressor'] * ps) / GB),
    pageSize: ps,
  };
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<string | undefined>;

/** Runs a command with a timeout; resolves to stdout, or undefined on any failure (missing binary, timeout, non-zero exit). Never throws. */
export const defaultExec: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      (childProcess.execFile as any)(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err: any, stdout: string) => resolve(err ? undefined : String(stdout)));
    } catch {
      resolve(undefined);
    }
  });

/** One memory reading. On macOS: exact (Activity-Monitor-style). Elsewhere: an approximation from Node's os module, flagged as such. Undefined only if even the fallback fails. */
export async function readMemorySample(rawExec: ExecFn = defaultExec, platform: string = process.platform, timeoutMs = 1500): Promise<MemorySample | undefined> {
  const tsMs = Date.now();
  // An injected/failed exec must never throw out of the sampler — a thrown error becomes "no data" for that source.
  const exec: ExecFn = async (cmd, args, t) => { try { return await rawExec(cmd, args, t); } catch { return undefined; } };
  if (platform === 'darwin') {
    const [memsize, vmText, swapText, pressText, levelText] = await Promise.all([
      exec('sysctl', ['-n', 'hw.memsize'], timeoutMs),
      exec('vm_stat', [], timeoutMs),
      exec('sysctl', ['-n', 'vm.swapusage'], timeoutMs),
      exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], timeoutMs),
      exec('sysctl', ['-n', 'kern.memorystatus_level'], timeoutMs),
    ]);
    const total = Number((memsize || '').trim());
    const vm = vmText ? parseVmStat(vmText) : undefined;
    const mem = vm && total ? computeMemory(total, vm) : undefined;
    if (mem) {
      const swap = swapText ? parseSwapUsage(swapText) : undefined;
      const level = Number((levelText || '').trim());
      return {
        ...mem,
        swapUsedGB: swap ? round2(swap.usedGB) : undefined,
        swapTotalGB: swap ? round2(swap.totalGB) : undefined,
        pressure: pressText ? parsePressureLevel(pressText) : 'unknown',
        pressureLevelPct: Number.isFinite(level) && levelText ? level : undefined,
        source: 'darwin',
        tsMs,
      };
    }
  }
  // Fallback: rough, clearly labelled. (os.freemem() undercounts reclaimable memory on macOS; on Linux it maps to MemAvailable-ish.)
  const total = os.totalmem();
  const free = os.freemem();
  if (!total) return undefined;
  return {
    totalGB: round1(total / GB), usedGB: round1((total - free) / GB), availableGB: round1(free / GB), cachedGB: 0, freeGB: round1(free / GB),
    wiredGB: 0, compressedGB: 0, pressure: 'unknown', source: 'approximate', tsMs,
  };
}
