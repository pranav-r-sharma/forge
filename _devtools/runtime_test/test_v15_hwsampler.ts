// ============================================================================
// 0.15.0 (P0-3): accurate memory readout — src/util/hwSampler.ts.
// Locks down the accuracy rules from the plan (§1.4): page size read from vm_stat's own header (never assumed 4096), Activity-Monitor-style
// used/available accounting, "n/a" (undefined) instead of a guess when a source is missing or implausible, no sudo, exec failures never throw.
// Fixture: a real `vm_stat` capture from an Apple-silicon Mac (16 KB pages).
// ============================================================================
import * as fs from 'fs';
import * as path from 'path';
import { parseVmStat, parseSwapUsage, parsePressureLevel, computeMemory, readMemorySample, ExecFn } from '../../src/util/hwSampler';

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

async function testLiveMac() {
  if (process.platform !== 'darwin') { ok(true, '(skipped live check: not macOS)'); return; }
  const s = await readMemorySample();
  ok(!!s && s.source === 'darwin', 'LIVE: exact darwin sample is obtained without sudo');
  if (!s) return;
  ok(s.pageSize === 16384 || s.pageSize === 4096, `LIVE: page size read from this machine (${s.pageSize})`);
  ok(s.usedGB > 0.5 && s.usedGB < s.totalGB, `LIVE: used is sane (${s.usedGB} of ${s.totalGB} GB)`);
  ok(near(s.usedGB + s.availableGB, s.totalGB, 0.11), 'LIVE: used + available ≈ total');
  ok(['normal', 'warn', 'critical'].includes(s.pressure), `LIVE: macOS pressure state is read (${s.pressure})`);
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
  await testLiveMac();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 hwSampler tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 hwSampler tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_hwsampler.ts:', err); process.exit(1); });
