import { MachineProfile, effectiveGpuMemoryBudgetGB } from '../../src/util/hwSampler';
import { computeMemoryBudget, recommend } from '../../src/util/recommendations';

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

function baseCurrent() {
  return {
    provider: 'mlx' as const,
    numCtx: 131072,
    mlxPromptCacheGB: 32,
    mlxPromptCacheSize: 256,
    mlxPrefillStepSize: 4096,
    maxOutputTokens: 0,
    maxOutputTokensCeiling: 0,
    keepAliveMinutes: -1,
    maxContextFileKB: 8192,
  };
}

function profile128Idle(): MachineProfile {
  return {
    totalRamGB: 128,
    chipName: 'Apple M5 Max',
    performanceCoreCount: 12,
    efficiencyCoreCount: 4,
    memory: {
      totalGB: 128,
      usedGB: 24,
      availableGB: 104,
      cachedGB: 40,
      freeGB: 20,
      wiredGB: 8,
      compressedGB: 0,
      swapUsedGB: 0,
      pressure: 'normal',
      source: 'darwin',
      tsMs: 1,
    },
    gpuWiredLimitUsesSystemDefault: true,
    effectiveGpuMemoryBudgetGB: effectiveGpuMemoryBudgetGB(128, 0).budgetGB,
    sampledAtMs: 1,
  };
}

function testBudget() {
  const idle = computeMemoryBudget(profile128Idle(), 0);
  ok(idle.kvBudgetGB > 60, `128 GB idle KV budget is large (${idle.kvBudgetGB} GB)`);
  const half = profile128Idle();
  half.memory = { ...half.memory!, usedGB: 64, availableGB: 64 };
  const halfB = computeMemoryBudget(half, 12);
  ok(halfB.kvBudgetGB < idle.kvBudgetGB, 'half-used RAM lowers KV budget');
  const p32 = profile128Idle();
  p32.totalRamGB = 32;
  p32.memory = { ...p32.memory!, totalGB: 32, availableGB: 8, usedGB: 24, pressure: 'warn', swapUsedGB: 1.2 };
  const tight = computeMemoryBudget(p32, 10);
  ok(tight.tight && tight.kvBudgetGB < 10, `32 GB under pressure is tight (${tight.kvBudgetGB} GB)`);
}

function testRecommendProfiles() {
  const idleRecs = recommend(profile128Idle(), baseCurrent());
  ok(idleRecs.length >= 8, `idle 128 GB yields ${idleRecs.length} recommendations`);
  const ctx = idleRecs.find((r) => r.settingKey === 'numCtx');
  ok(!!ctx && ctx!.recommended >= 65536, `idle context recommendation is generous (${ctx?.recommended})`);
  ok(ctx!.reason.includes('75%') || ctx!.reason.includes('KV'), 'context reason mentions budget assumptions');

  const half = profile128Idle();
  half.memory = { ...half.memory!, usedGB: 70, availableGB: 58 };
  const halfRecs = recommend(half, baseCurrent(), { modelSizeGB: 12 });
  const cache = halfRecs.find((r) => r.settingKey === 'mlx.promptCacheGB');
  ok(!!cache && cache!.recommended <= 32, 'loaded model reduces prompt cache suggestion');

  const p32 = profile128Idle();
  p32.totalRamGB = 32;
  p32.effectiveGpuMemoryBudgetGB = 24;
  p32.memory = {
    totalGB: 32,
    usedGB: 28,
    availableGB: 4,
    cachedGB: 2,
    freeGB: 0.5,
    wiredGB: 6,
    compressedGB: 1,
    swapUsedGB: 3,
    pressure: 'critical',
    source: 'darwin',
    tsMs: 1,
  };
  const pressureRecs = recommend(p32, baseCurrent(), { modelSizeGB: 8 });
  const pCtx = pressureRecs.find((r) => r.settingKey === 'numCtx');
  ok(!!pCtx && pCtx!.recommended <= 98304, `under pressure context is reduced (${pCtx?.recommended})`);
  ok(pCtx!.reason.toLowerCase().includes('swap') || pCtx!.reason.includes('critical'), 'pressure reason mentions swap or critical');
  const keep = pressureRecs.find((r) => r.settingKey === 'keepAliveMinutes');
  ok(keep && keep.recommended >= 0 && keep.recommended < 60, 'keepAlive shortened under pressure');
}

function test128Example() {
  const recs = recommend(profile128Idle(), {
    ...baseCurrent(),
    numCtx: 32768,
    mlxPromptCacheGB: 4,
  });
  const ctx = recs.find((r) => r.settingKey === 'numCtx')!;
  console.log(`   (example 128 GB idle) numCtx → ${ctx.recommended}: ${ctx.reason.slice(0, 120)}…`);
  ok(ctx.recommended > 32768, '128 GB idle recommends raising low numCtx');
}

async function main() {
  testBudget();
  testRecommendProfiles();
  test128Example();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.15.0 recommendations tests FAILED.');
    process.exit(1);
  }
  console.log('All v0.15.0 recommendations tests passed.');
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
