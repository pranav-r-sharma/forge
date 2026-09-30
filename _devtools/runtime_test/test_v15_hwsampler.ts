// ============================================================================
// 0.15.0 (P0-3): accurate memory readout — src/util/hwSampler.ts.
// Locks down the accuracy rules from the plan (§1.4): page size read from vm_stat's own header (never assumed 4096), Activity-Monitor-style
// used/available accounting, "n/a" (undefined) instead of a guess when a source is missing or implausible, no sudo, exec failures never throw.
// Fixture: a real `vm_stat` capture from an Apple-silicon Mac (16 KB pages).
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { parseVmStat, parseSwapUsage, parsePressureLevel, computeMemory, readMemorySample, parseIoregAccelerator, readGpuSamples, readGpuWiredLimitMB, readGpuWiredLimitRawMB, effectiveGpuMemoryBudgetGB, readMachineProfile, averageOverWindow, HwSampler, hwFieldsForUi, ExecFn } from '../../src/util/hwSampler';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}
const near = (a: number | undefined, b: number, tol: number) => typeof a === 'number' && Math.abs(a - b) <= tol;
const GB = 1024 ** 3;
const REAL_VM = fs.readFileSync(path.join(__dirname, 'fixtures/hw/vm_stat_darwin_arm64_16k.txt'), 'utf8');

function testParseVmStat() {
  const vm = parseVmStat(REAL_VM)!;
  ok(vm && vm.pageSize === 16384, `page size is read from the header (16384 on Apple silicon), not assumed (got ${vm && vm.pageSize})`);
  ok(typeof vm.pages['Pages free'] === 'number' && vm.pages['Pages free'] > 0, 'parses "Pages free"');
  ok(typeof vm.pages['File-backed pages'] === 'number' && typeof vm.pages['Anonymous pages'] === 'number', 'parses file-backed and anonymous page counts');
  ok(typeof vm.pages['Translation faults'] === 'number', 'parses quoted counter names ("Translation faults")');
  ok(parseVmStat('Pages free: 100.\nPages active: 5.') === undefined, 'no page-size header → undefined (n/a), never a guessed 4096');
  ok(parseVmStat('') === undefined && parseVmStat(undefined as any) === undefined, 'empty / undefined input → undefined, no throw');
  const junk = parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:   12.\nthis line is garbage\nPages active: abc.\n')!;
  ok(junk.pageSize === 4096 && junk.pages['Pages free'] === 12 && junk.pages['Pages active'] === undefined, 'garbage / non-numeric lines are skipped, valid ones kept');
  ok(parseVmStat('Mach Virtual Memory Statistics: (page size of 12 bytes)') === undefined, 'an absurd page size is rejected');
}

function testComputeMemory() {
  const vm = parseVmStat(REAL_VM)!;
  const total = 32 * GB;
  const m = computeMemory(total, vm)!;
  ok(!!m, 'a real fixture computes');
  const p = vm.pages;
  const expectedUsed = ((p['Anonymous pages'] - p['Pages purgeable']) + p['Pages wired down'] + p['Pages occupied by compressor']) * 16384 / GB;
  ok(near(m.usedGB, expectedUsed, 0.06), `used = (anonymous − purgeable) + wired + compressed, the Activity Monitor definition (got ${m.usedGB}, expected ~${expectedUsed.toFixed(2)})`);
  ok(near(m.usedGB + m.availableGB, m.totalGB, 0.11), `used + available ≈ total (got ${m.usedGB} + ${m.availableGB} vs ${m.totalGB})`);
  ok(m.cachedGB > 0 && m.availableGB >= m.freeGB, 'cached files are counted as available (reclaimable), and available ≥ truly-free');
  ok(m.usedGB > 0 && m.usedGB < 32, 'used is a sane number for a 32 GB machine');
  // The reason this module exists: Node's freemem-based "used" (total − free pages only) overstates. Free pages alone are far below available.
  ok(m.freeGB < m.availableGB, 'never-touched pages alone are less than what is really available (the os.freemem() error this fixes)');
  // Page-size trap: the same page COUNTS interpreted at 4096 would be 4× too small — prove the parsed size is what scales the result.
  const asIf4k = computeMemory(total, { pageSize: 4096, pages: vm.pages })!;
  ok(near(asIf4k.wiredGB * 4, m.wiredGB, 0.3), 'results scale with the parsed page size (a wrong 4096 assumption would under-read ~4×)');
  ok(computeMemory(total, { pageSize: 16384, pages: { 'Pages free': 5 } }) === undefined, 'missing counters → undefined (n/a), not a partial guess');
  ok(computeMemory(0, vm) === undefined, 'unknown total memory → undefined');
  const absurd = computeMemory(1 * GB, vm);
  ok(absurd === undefined, 'implausible input (used ≫ total) → undefined rather than a wrong number');
}

function testSwapAndPressure() {
  const s = parseSwapUsage('total = 2048.00M  used = 828.38M  free = 1219.62M  (encrypted)')!;
  ok(near(s.totalGB, 2, 0.01) && near(s.usedGB, 0.809, 0.01), `swap parses MB → GB (got ${JSON.stringify(s)})`);
  const g = parseSwapUsage('total = 4.00G  used = 1.50G  free = 2.50G')!;
  ok(near(g.totalGB, 4, 0.001) && near(g.usedGB, 1.5, 0.001), 'swap parses G units');
  ok(parseSwapUsage('nonsense') === undefined && parseSwapUsage('') === undefined, 'unparseable swap → undefined');
  ok(parsePressureLevel('1\n') === 'normal' && parsePressureLevel('2') === 'warn' && parsePressureLevel('4') === 'critical', 'pressure levels 1/2/4 map to normal/warn/critical');
  ok(parsePressureLevel('') === 'unknown' && parsePressureLevel('7') === 'unknown' && parsePressureLevel('x') === 'unknown', 'unknown pressure input → "unknown", not a guess');
}

async function testReadMemorySampleWithFakes() {
  const good: ExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'sysctl -n hw.memsize') return String(32 * GB) + '\n';
    if (cmd === 'vm_stat') return REAL_VM;
    if (key === 'sysctl -n vm.swapusage') return 'total = 2048.00M  used = 1060.50M  free = 987.50M  (encrypted)\n';
    if (key === 'sysctl -n kern.memorystatus_vm_pressure_level') return '1\n';
    if (key === 'sysctl -n kern.memorystatus_level') return '88\n';
    return undefined;
  };
  const s = (await readMemorySample(good, 'darwin'))!;
  ok(s && s.source === 'darwin' && s.pressure === 'normal' && s.pageSize === 16384, 'darwin path returns an exact-source sample with pressure and page size');
  ok(near(s.swapUsedGB, 1.04, 0.02) && s.pressureLevelPct === 88, 'swap and the informational pressure % are carried through');
  ok(near(s.totalGB, 32, 0.05), 'total comes from hw.memsize');

  const noVm: ExecFn = async (cmd, args) => (cmd === 'vm_stat' ? undefined : good(cmd, args, 1));
  const fb = (await readMemorySample(noVm, 'darwin'))!;
  ok(fb && fb.source === 'approximate', 'if vm_stat fails, falls back to a clearly-flagged approximation instead of failing or faking exactness');

  const throwing: ExecFn = async () => { throw new Error('boom'); };
  let threw = false;
  let afterThrow: any;
  try { afterThrow = await readMemorySample(throwing, 'darwin'); } catch { threw = true; }
  ok(!threw, 'an exec function that THROWS never propagates out of readMemorySample');
  ok(afterThrow && afterThrow.source === 'approximate', 'and the result degrades to the labelled approximation (no fake exactness)');
  const nonDarwin = (await readMemorySample(async () => undefined, 'linux'))!;
  ok(nonDarwin && nonDarwin.source === 'approximate' && nonDarwin.totalGB > 0, 'non-macOS uses the labelled approximation');
}

const REAL_IOREG = fs.readFileSync(path.join(__dirname, 'fixtures/hw/ioreg_accelerator_apple_silicon.txt'), 'utf8');

function testGpuParsing() {
  const g = parseIoregAccelerator(REAL_IOREG, 123);
  ok(g.length === 1, `one accelerator parsed from a real Apple-silicon capture (got ${g.length})`);
  ok(g[0].utilizationPct === 3 && g[0].rendererPct === 3 && g[0].tilerPct === 2, `device/renderer/tiler utilization read (got ${JSON.stringify(g[0])})`);
  ok(g[0].name === 'Apple M5' && g[0].cores === 10, 'GPU model and core count read');
  ok(near(g[0].inUseGB, 329596928 / GB, 0.01) && near(g[0].allocatedGB, 1179123712 / GB, 0.01), 'in-use and allocated system memory converted bytes → GB');
  ok(g[0].tsMs === 123, 'timestamp carried through');
  ok(parseIoregAccelerator('').length === 0 && parseIoregAccelerator(undefined as any).length === 0, 'empty input → [] (n/a), no throw');
  ok(parseIoregAccelerator('+-o Foo\n  "PerformanceStatistics" = {"Alloc system memory"=5}\n').length === 0, 'a node with no utilization figure is skipped rather than reported as 0%');
  const two = REAL_IOREG + '\n' + REAL_IOREG.replace('"Device Utilization %"=3', '"Device Utilization %"=57').replace('AGXAcceleratorG17G  <class', 'AGXOther  <class');
  const tg = parseIoregAccelerator(two);
  ok(tg.length === 2 && tg[1].utilizationPct === 57, 'multiple accelerators (e.g. Intel Mac with iGPU + dGPU) are each reported');
  ok(parseIoregAccelerator(REAL_IOREG.replace('"Device Utilization %"=3', '"Device Utilization %"=250'))[0].utilizationPct === 100, 'an out-of-range percentage is clamped to 100, not shown as 250%');
}

async function testGpuReadWithFakes() {
  const good: ExecFn = async (cmd) => (cmd === 'ioreg' ? REAL_IOREG : cmd === 'sysctl' ? '0\n' : undefined);
  const s = await readGpuSamples(good, 'darwin');
  ok(s.length === 1 && s[0].utilizationPct === 3, 'readGpuSamples returns the parsed sample');
  ok((await readGpuSamples(async () => undefined, 'darwin')).length === 0, 'ioreg failing → [] (n/a)');
  ok((await readGpuSamples(async () => { throw new Error('x'); }, 'darwin')).length === 0, 'a throwing exec → [] and no exception');
  ok((await readGpuSamples(good, 'linux')).length === 0, 'non-macOS → [] (the caller may fall back to nvidia-smi separately)');
  ok((await readGpuWiredLimitMB(good, 'darwin')) === undefined, 'wired limit 0 (system default) → undefined, not "0 MB"');
  ok((await readGpuWiredLimitMB(async () => '20480\n', 'darwin')) === 20480, 'a configured wired limit is read (read-only — Forge never sets it)');
}

function testSmoothing() {
  const h = [{ t: 1000, v: 100 }, { t: 2000, v: 0 }, { t: 3000, v: 50 }, { t: 9000, v: 10 }];
  ok(averageOverWindow(h, 3000, 4000) === 50, 'mean over the window (1000 falls outside a 4 s window ending at 3000? no — (−1000,3000] includes all three → 50)');
  ok(averageOverWindow(h, 9000, 4000) === 10, 'old samples outside the window are ignored');
  ok(averageOverWindow(h, 20000, 4000) === undefined, 'an empty window → undefined, not 0');
  ok(averageOverWindow([], 5, 10) === undefined, 'no history → undefined');
}

async function testSampler() {
  let t = 100000;
  let util = 90;
  let calls = 0;
  const ioregFor = (u: number) => REAL_IOREG.replace('"Device Utilization %"=3', `"Device Utilization %"=${u}`);
  const exec: ExecFn = async (cmd, args) => {
    calls++;
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'sysctl -n hw.memsize') return String(32 * GB);
    if (cmd === 'vm_stat') return REAL_VM;
    if (key === 'sysctl -n vm.swapusage') return 'total = 2048.00M  used = 100.00M  free = 1948.00M';
    if (key === 'sysctl -n kern.memorystatus_vm_pressure_level') return '1';
    if (key === 'sysctl -n kern.memorystatus_level') return '80';
    if (key === 'sysctl -n iogpu.wired_limit_mb') return '0';
    if (cmd === 'ioreg') return ioregFor(util);
    return undefined;
  };
  const s = new HwSampler({ exec, platform: 'darwin', now: () => t, windowMs: 4000 });
  const a = await s.sampleOnce();
  ok(a.memory?.source === 'darwin' && a.gpus.length === 1 && a.gpus[0].utilizationPct === 90, 'first sample has memory and the GPU instant');
  ok(a.gpus[0].avgPct === 90 && a.gpus[0].peakPct === 90, 'first sample: average = instant, peak = instant');
  t += 1000; util = 10; const b = await s.sampleOnce();
  ok(b.gpus[0].utilizationPct === 10 && b.gpus[0].avgPct === 50, `the displayed average smooths a 90→10 swing (got avg ${b.gpus[0].avgPct}, instant ${b.gpus[0].utilizationPct})`);
  ok(b.gpus[0].peakPct === 90, 'peak remembers the highest instant');
  s.resetPeak(); t += 1000; util = 20; const c = await s.sampleOnce();
  ok(c.gpus[0].peakPct === 20, `resetPeak() starts a fresh per-turn peak (got ${c.gpus[0].peakPct})`);
  t += 10000; util = 30; const d = await s.sampleOnce();
  ok(d.gpus[0].avgPct === 30, 'after the window passes, old samples no longer influence the average');
  ok(d.gpuWiredLimitMB === undefined, 'system-default wired limit stays undefined');
  const before = calls;
  const [p, q] = await Promise.all([s.sampleOnce(), s.sampleOnce()]);
  ok(p === q, 'concurrent sampleOnce() callers share one in-flight read');
  ok(calls - before <= 8, `and did not double the exec load (${calls - before} execs for one shared read)`);

  // failed source clears to n/a rather than showing a stale value as live
  let broken = false;
  const flaky: ExecFn = async (cmd, args, tm) => (broken && cmd === 'ioreg' ? undefined : exec(cmd, args, tm));
  const f = new HwSampler({ exec: flaky, platform: 'darwin', now: () => t });
  await f.sampleOnce(); broken = true; const after = await f.sampleOnce();
  ok(after.gpus.length === 0 && !!after.memory, 'GPU source failing → no GPU shown (n/a), memory unaffected; stale value not carried');

  // start/stop loop delivers samples and stops cleanly
  const loop = new HwSampler({ exec, platform: 'darwin' });
  const keepAlive = setInterval(() => {}, 1000); // the sampler's own timer is unref'd (correct in VS Code) — keep THIS process alive while we wait
  let n = 0;
  await new Promise<void>((resolve) => { loop.start(250, () => { n++; if (n >= 2) { loop.stop(); resolve(); } }); });
  const stoppedAt = n; await new Promise((r) => setTimeout(r, 700));
  clearInterval(keepAlive);
  ok(n >= 2 && n === stoppedAt, `start() delivers repeated samples and stop() halts them (got ${n}, still ${stoppedAt} after stop)`);
}

async function testUiMapping() {
  const exec: ExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'sysctl -n hw.memsize') return String(32 * GB);
    if (cmd === 'vm_stat') return REAL_VM;
    if (key === 'sysctl -n vm.swapusage') return 'total = 2048.00M  used = 900.00M  free = 1148.00M';
    if (key === 'sysctl -n kern.memorystatus_vm_pressure_level') return '2';
    if (cmd === 'ioreg') return REAL_IOREG.replace('"Device Utilization %"=3', '"Device Utilization %"=64');
    return '0';
  };
  const snap = await new HwSampler({ exec, platform: 'darwin' }).sampleOnce();
  const ui = hwFieldsForUi(snap);
  ok(ui.memory?.pressure === 'warn' && ui.memory.source === 'darwin' && typeof ui.memory.sampledAtMs === 'number', 'UI memory carries pressure, source and a timestamp for the "age" tooltip');
  ok(ui.memory && near(ui.memory.usedGB + ui.memory.availableGB, ui.memory.totalGB, 0.11), 'UI memory: used + available ≈ total');
  ok(near(ui.memory?.swapUsedGB, 0.88, 0.02), 'swap is mapped');
  ok(ui.gpus?.length === 1 && ui.gpus[0].avgPct === 64 && ui.gpus[0].peakPct === 64 && ui.gpus[0].name === 'Apple M5', 'UI gpus carries smoothed avg, peak and name');
  const empty = hwFieldsForUi({ gpus: [] });
  ok(empty.memory === undefined && empty.gpus === undefined, 'no data → both undefined so the UI renders "n/a"');
}

function testGpuBudgetDefault() {
  const b = effectiveGpuMemoryBudgetGB(128, 0);
  ok(b.usesSystemDefault && near(b.budgetGB, 96, 0.2), `128 GB with sysctl 0 → ~75% GPU budget (${b.budgetGB} GB)`);
  ok(effectiveGpuMemoryBudgetGB(128, 65536).budgetGB === 64, 'explicit wired limit overrides default fraction');
}

async function testMachineProfileFakes() {
  const exec: ExecFn = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    if (key === 'sysctl -n hw.memsize') return String(128 * GB) + '\n';
    if (key === 'sysctl -n machdep.cpu.brand_string') return 'Apple M5 Max\n';
    if (key === 'sysctl -n hw.perflevel0.physicalcpu') return '12\n';
    if (key === 'sysctl -n hw.perflevel1.physicalcpu') return '4\n';
    if (key === 'sysctl -n iogpu.wired_limit_mb') return '0\n';
    if (cmd === 'vm_stat') return REAL_VM;
    if (key === 'sysctl -n vm.swapusage') return 'total = 0.00M  used = 0.00M  free = 0.00M';
    if (key === 'sysctl -n kern.memorystatus_vm_pressure_level') return '1\n';
    if (key === 'sysctl -n kern.memorystatus_level') return '90\n';
    if (cmd === 'ioreg') return REAL_IOREG;
    return undefined;
  };
  const p = await readMachineProfile(exec, 'darwin', { loadedModelSizeGB: 5.2 });
  ok(p.chipName === 'Apple M5 Max' && p.performanceCoreCount === 12 && p.efficiencyCoreCount === 4, 'CPU brand and core counts read');
  ok(near(p.totalRamGB, 128, 1), 'total RAM from hw.memsize');
  ok(p.gpuWiredLimitUsesSystemDefault && near(p.effectiveGpuMemoryBudgetGB, 96, 1), 'wired limit 0 → documented default budget');
  ok(p.loadedModelSizeGB === 5.2 && typeof p.gpuUtilizationPct === 'number', 'model size and GPU util carried through');
  ok((await readGpuWiredLimitRawMB(exec, 'darwin')) === 0, 'raw wired limit can be 0');
}

async function testLiveMac() {
  if (process.platform !== 'darwin') { ok(true, '(skipped live check: not macOS)'); return; }
  const s = await readMemorySample();
  ok(!!s && s.source === 'darwin', 'LIVE: exact darwin sample is obtained without sudo');
  if (!s) return;
  ok(s.pageSize === 16384 || s.pageSize === 4096, `LIVE: page size read from this machine (${s.pageSize})`);
  ok(s.usedGB > 0.5 && s.usedGB < s.totalGB, `LIVE: used is sane (${s.usedGB} of ${s.totalGB} GB)`);
  ok(near(s.usedGB + s.availableGB, s.totalGB, 0.11), 'LIVE: used + available ≈ total');
  ok(['normal', 'warn', 'critical'].includes(s.pressure), `LIVE: macOS pressure state is read (${s.pressure})`);
  const gpu = await readGpuSamples();
  ok(gpu.length >= 1 && gpu[0].utilizationPct >= 0 && gpu[0].utilizationPct <= 100, `LIVE: GPU utilization read without sudo (${gpu[0] ? gpu[0].utilizationPct + '%, ' + gpu[0].name : 'none'})`);
  const os = require('os');
  const naive = (os.totalmem() - os.freemem()) / GB;
  console.log(`   (info) naive os.freemem() "used" = ${naive.toFixed(1)} GB vs accurate used = ${s.usedGB} GB`);
  ok(naive >= s.usedGB - 0.5, 'LIVE: the old os.freemem()-based "used" is not lower than the accurate one (it overstates)');
}

async function main() {
  testParseVmStat();
  testComputeMemory();
  testSwapAndPressure();
  await testReadMemorySampleWithFakes();
  testGpuParsing();
  await testGpuReadWithFakes();
  testSmoothing();
  await testSampler();
  await testUiMapping();
  testGpuBudgetDefault();
  await testMachineProfileFakes();
  await testLiveMac();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 hwSampler tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 hwSampler tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_hwsampler.ts:', err); process.exit(1); });
