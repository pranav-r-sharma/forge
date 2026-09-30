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

// ---------------------------------------------------------------------------------------------------------------------------------------
// GPU (Apple silicon and Intel/AMD Macs): unprivileged, from IOKit via `ioreg` — no sudo, no powermetrics.
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface GpuSample {
  name?: string;
  cores?: number;
  /** "Device Utilization %" — overall GPU busy %, an instantaneous sample (jumpy: smooth over a few seconds before displaying). */
  utilizationPct: number;
  rendererPct?: number;
  tilerPct?: number;
  /** GPU-visible system memory currently in use, GB. On Apple silicon this is the SAME unified memory as RAM, not a separate VRAM pool. */
  inUseGB?: number;
  allocatedGB?: number;
  tsMs: number;
}

/** Parses `ioreg -r -d 1 -w0 -c IOAccelerator`. Returns one sample per accelerator that exposes a PerformanceStatistics dictionary; [] if none/unparseable. */
export function parseIoregAccelerator(text: string, tsMs: number = Date.now()): GpuSample[] {
  const out: GpuSample[] = [];
  if (!text) return out;
  for (const block of text.split(/^(?=\+-o )/m)) {
    const stats = /"PerformanceStatistics"\s*=\s*\{([^}]*)\}/.exec(block);
    if (!stats) continue;
    const num = (key: string): number | undefined => {
      const m = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&') + '"\\s*=\\s*(\\d+)').exec(stats[1]);
      return m ? Number(m[1]) : undefined;
    };
    const dev = num('Device Utilization %');
    if (dev === undefined) continue; // no utilization figure → nothing trustworthy to report for this node
    const clamp = (n: number | undefined) => (n === undefined ? undefined : Math.max(0, Math.min(100, n)));
    const inUse = num('In use system memory');
    const alloc = num('Alloc system memory');
    const name = /"model"\s*=\s*"([^"]+)"/.exec(block);
    const cores = /"gpu-core-count"\s*=\s*(\d+)/.exec(block);
    out.push({
      name: name ? name[1] : undefined,
      cores: cores ? Number(cores[1]) : undefined,
      utilizationPct: clamp(dev)!,
      rendererPct: clamp(num('Renderer Utilization %')),
      tilerPct: clamp(num('Tiler Utilization %')),
      inUseGB: inUse === undefined ? undefined : round2(inUse / GB),
      allocatedGB: alloc === undefined ? undefined : round2(alloc / GB),
      tsMs,
    });
  }
  return out;
}

/** One GPU reading (macOS only). [] if unavailable — the caller shows "n/a", never a made-up percentage. */
export async function readGpuSamples(exec: ExecFn = defaultExec, platform: string = process.platform, timeoutMs = 1500): Promise<GpuSample[]> {
  if (platform !== 'darwin') return [];
  try {
    const text = await exec('ioreg', ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator'], timeoutMs);
    return text ? parseIoregAccelerator(text) : [];
  } catch {
    return [];
  }
}

/**
 * The OS's GPU wired-memory override in MB, or undefined when it is the system default (sysctl reports 0). READ ONLY — raising it needs
 * sudo, which Forge never uses (owner Directive 6). Metal's actual recommended working set (~78% of RAM on a 32 GB M5) comes from the
 * MLX/Metal device info, not from sysctl; see the MLX provider (P0-11/12).
 */
export async function readGpuWiredLimitMB(exec: ExecFn = defaultExec, platform: string = process.platform, timeoutMs = 1500): Promise<number | undefined> {
  const raw = await readGpuWiredLimitRawMB(exec, platform, timeoutMs);
  return raw !== undefined && raw > 0 ? raw : undefined;
}

/** Raw sysctl value for `iogpu.wired_limit_mb` (0 means macOS default — see effectiveGpuMemoryBudgetGB). */
export async function readGpuWiredLimitRawMB(exec: ExecFn = defaultExec, platform: string = process.platform, timeoutMs = 1500): Promise<number | undefined> {
  if (platform !== 'darwin') return undefined;
  try {
    const n = Number(((await exec('sysctl', ['-n', 'iogpu.wired_limit_mb'], timeoutMs)) || '').trim());
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When `iogpu.wired_limit_mb` is 0, macOS applies its own GPU wired-memory cap (not readable without private APIs).
 * On large unified-memory Macs this is commonly ~75% of physical RAM — used only for recommendations, never to change settings.
 */
export const IOGPU_WIRED_DEFAULT_RAM_FRACTION = 0.75;

export function effectiveGpuMemoryBudgetGB(totalRamGB: number, wiredLimitRawMB?: number): { budgetGB: number; usesSystemDefault: boolean } {
  if (!totalRamGB || totalRamGB <= 0) return { budgetGB: 0, usesSystemDefault: false };
  if (wiredLimitRawMB !== undefined && wiredLimitRawMB > 0) {
    return { budgetGB: round2(wiredLimitRawMB / 1024), usesSystemDefault: false };
  }
  return { budgetGB: round1(totalRamGB * IOGPU_WIRED_DEFAULT_RAM_FRACTION), usesSystemDefault: true };
}

/** Read-only machine profile for settings recommendations (never changes system state). */
export interface MachineProfile {
  chipName?: string;
  performanceCoreCount?: number;
  efficiencyCoreCount?: number;
  totalRamBytes?: number;
  totalRamGB?: number;
  memory?: MemorySample;
  gpuWiredLimitMB?: number;
  gpuWiredLimitUsesSystemDefault?: boolean;
  effectiveGpuMemoryBudgetGB?: number;
  gpuUtilizationPct?: number;
  gpuInUseGB?: number;
  loadedModelSizeGB?: number;
  sampledAtMs: number;
}

export function parseSysctlInt(text: string | undefined): number | undefined {
  const n = Number((text || '').trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Builds a machine profile from sysctl/vm_stat/ioreg (and optional resident model size from ps()).
 * Reuses `hwSnapshot` when supplied so callers can avoid duplicate memory/GPU reads.
 */
export async function readMachineProfile(
  rawExec: ExecFn = defaultExec,
  platform: string = process.platform,
  opts: { loadedModelSizeGB?: number; hwSnapshot?: HwSnapshot; timeoutMs?: number } = {}
): Promise<MachineProfile> {
  const exec: ExecFn = async (cmd, args, t) => {
    try {
      return await rawExec(cmd, args, t);
    } catch {
      return undefined;
    }
  };
  const timeoutMs = opts.timeoutMs ?? 1500;
  const tsMs = opts.hwSnapshot?.sampledAtMs ?? Date.now();
  const memory = opts.hwSnapshot?.memory ?? (await readMemorySample(exec, platform, timeoutMs));
  const gpus = opts.hwSnapshot?.gpus?.length ? opts.hwSnapshot.gpus : await readGpuSamples(exec, platform, timeoutMs);
  const wiredFromSnap = opts.hwSnapshot?.gpuWiredLimitMB;
  const wiredRaw =
    wiredFromSnap !== undefined
      ? wiredFromSnap
      : await readGpuWiredLimitRawMB(exec, platform, timeoutMs);
  const [memsizeText, brand, p0, p1] =
    platform === 'darwin'
      ? await Promise.all([
          exec('sysctl', ['-n', 'hw.memsize'], timeoutMs),
          exec('sysctl', ['-n', 'machdep.cpu.brand_string'], timeoutMs),
          exec('sysctl', ['-n', 'hw.perflevel0.physicalcpu'], timeoutMs),
          exec('sysctl', ['-n', 'hw.perflevel1.physicalcpu'], timeoutMs),
        ])
      : [undefined, undefined, undefined, undefined];
  const totalRamBytes = parseSysctlInt(memsizeText) ?? (memory ? Math.round(memory.totalGB * GB) : undefined);
  const totalRamGB = memory?.totalGB ?? (totalRamBytes ? round1(totalRamBytes / GB) : undefined);
  const { budgetGB, usesSystemDefault } = effectiveGpuMemoryBudgetGB(totalRamGB ?? 0, wiredRaw);
  const primaryGpu = gpus[0];
  return {
    chipName: brand?.trim() || undefined,
    performanceCoreCount: parseSysctlInt(p0),
    efficiencyCoreCount: parseSysctlInt(p1),
    totalRamBytes,
    totalRamGB,
    memory,
    gpuWiredLimitMB: wiredRaw !== undefined && wiredRaw > 0 ? wiredRaw : undefined,
    gpuWiredLimitUsesSystemDefault: usesSystemDefault,
    effectiveGpuMemoryBudgetGB: totalRamGB ? budgetGB : undefined,
    gpuUtilizationPct: primaryGpu?.utilizationPct,
    gpuInUseGB: primaryGpu?.inUseGB,
    loadedModelSizeGB: opts.loadedModelSizeGB,
    sampledAtMs: tsMs,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Continuous sampler: ONE timer in the extension host (not one per webview), GPU smoothing, per-turn peak.
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface SmoothedGpu extends GpuSample {
  /** Mean utilization over the recent window (default ~4 s). Show THIS, not the raw instant — a single sample swings 0↔100 within a second. */
  avgPct: number;
  /** Highest instant seen since resetPeak() (e.g. since the current turn started). */
  peakPct: number;
}

export interface HwSnapshot {
  memory?: MemorySample;
  gpus: SmoothedGpu[];
  /** OS GPU wired-memory override in MB, if one is configured (read-only; undefined = system default). */
  gpuWiredLimitMB?: number;
  /** When the newest reading was taken; consumers can show its age instead of pretending it is live. */
  sampledAtMs?: number;
}

/** Mean of the samples whose timestamp falls in (now − windowMs, now]. Undefined when the window is empty. Pure. */
export function averageOverWindow(history: { t: number; v: number }[], now: number, windowMs: number): number | undefined {
  const recent = history.filter((h) => h.t > now - windowMs && h.t <= now);
  if (!recent.length) return undefined;
  return recent.reduce((s, h) => s + h.v, 0) / recent.length;
}

export interface HwSamplerDeps {
  exec?: ExecFn;
  platform?: string;
  now?: () => number;
  /** Smoothing window for GPU utilization (ms). */
  windowMs?: number;
}

export class HwSampler {
  private snap: HwSnapshot = { gpus: [] };
  private gpuHistory: { t: number; v: number }[][] = [];
  private peaks: number[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private intervalMs = 2000;
  private onSample: ((s: HwSnapshot) => void) | undefined;
  private inFlight: Promise<HwSnapshot> | undefined;
  private wiredLimitRead = false;

  constructor(private readonly deps: HwSamplerDeps = {}) {}

  latest(): HwSnapshot {
    return this.snap;
  }

  /** Starts the single sampling loop. Each tick waits for the previous one to finish (no overlapping exec storms); the timer never keeps Node alive. */
  start(intervalMs = 2000, onSample?: (s: HwSnapshot) => void): void {
    this.intervalMs = Math.max(250, intervalMs);
    this.onSample = onSample;
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        const s = await this.sampleOnce();
        if (this.running) this.onSample?.(s);
      } catch {
        /* sampleOnce never throws in practice; a failure just means no update this tick */
      }
      if (this.running) {
        this.timer = setTimeout(tick, this.intervalMs);
        (this.timer as any)?.unref?.();
      }
    };
    void tick();
  }

  setIntervalMs(ms: number): void {
    this.intervalMs = Math.max(250, ms);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Forget peaks (call when a turn starts so "peak this turn" means this turn). */
  resetPeak(): void {
    this.peaks = this.peaks.map(() => 0);
  }

  /** Takes one reading now (coalesces concurrent callers onto the same in-flight read). Never throws. */
  sampleOnce(): Promise<HwSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doSample().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doSample(): Promise<HwSnapshot> {
    const exec = this.deps.exec ?? defaultExec;
    const platform = this.deps.platform ?? process.platform;
    const now = this.deps.now ?? Date.now;
    const windowMs = this.deps.windowMs ?? 4000;
    const [memory, gpuRaw] = await Promise.all([readMemorySample(exec, platform), readGpuSamples(exec, platform)]);
    if (!this.wiredLimitRead) {
      this.wiredLimitRead = true;
      this.snap.gpuWiredLimitMB = await readGpuWiredLimitMB(exec, platform);
    }
    const t = now();
    const gpus: SmoothedGpu[] = gpuRaw.map((g, i) => {
      const hist = (this.gpuHistory[i] = this.gpuHistory[i] || []);
      hist.push({ t, v: g.utilizationPct });
      while (hist.length && hist[0].t <= t - windowMs * 4) hist.shift(); // bounded memory
      this.peaks[i] = Math.max(this.peaks[i] || 0, g.utilizationPct);
      return { ...g, avgPct: Math.round(averageOverWindow(hist, t, windowMs) ?? g.utilizationPct), peakPct: this.peaks[i] };
    });
    // A source that failed this tick clears its value (→ "n/a") instead of showing a stale one as if it were live.
    this.snap = { memory, gpus, gpuWiredLimitMB: this.snap.gpuWiredLimitMB, sampledAtMs: t };
    return this.snap;
  }
}

/** Maps a sampler snapshot to the exact shape the webview protocol (HwStatus.memory / HwStatus.gpus) expects. Pure; kept separate so the mapping is testable without the provider. */
export function hwFieldsForUi(snap: HwSnapshot): {
  memory?: { totalGB: number; usedGB: number; availableGB: number; cachedGB: number; freeGB: number; wiredGB: number; compressedGB: number; swapUsedGB?: number; pressure: MemoryPressure; source: 'darwin' | 'approximate'; sampledAtMs: number };
  gpus?: { name?: string; cores?: number; utilizationPct: number; avgPct: number; peakPct: number; inUseGB?: number }[];
} {
  const m = snap.memory;
  return {
    memory: m
      ? { totalGB: m.totalGB, usedGB: m.usedGB, availableGB: m.availableGB, cachedGB: m.cachedGB, freeGB: m.freeGB, wiredGB: m.wiredGB, compressedGB: m.compressedGB, swapUsedGB: m.swapUsedGB, pressure: m.pressure, source: m.source, sampledAtMs: m.tsMs }
      : undefined,
    gpus: snap.gpus.length ? snap.gpus.map((g) => ({ name: g.name, cores: g.cores, utilizationPct: g.utilizationPct, avgPct: g.avgPct, peakPct: g.peakPct, inUseGB: g.inUseGB })) : undefined,
  };
}
