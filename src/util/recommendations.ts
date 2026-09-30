import { MachineProfile, effectiveGpuMemoryBudgetGB } from './hwSampler';
import { resolveEffectiveMaxOutputTokens } from './config';

export interface RecommendSettingsInput {
  provider: 'ollama' | 'mlx' | 'openai-compatible';
  numCtx: number;
  mlxPromptCacheGB: number;
  mlxPromptCacheSize: number;
  mlxPrefillStepSize: number;
  maxOutputTokens: number;
  maxOutputTokensCeiling: number;
  keepAliveMinutes: number;
  maxContextFileKB: number;
}

export interface ModelInfoForRecommend {
  maxContextTokens?: number;
  modelSizeGB?: number;
}

export interface SettingRecommendation {
  settingKey: string;
  recommended: number;
  reason: string;
}

const GB = 1024 ** 3;

function roundStep(n: number, step: number): number {
  if (step <= 0) return Math.round(n);
  return Math.round(n / step) * step;
}

function kvBytesPerToken(modelSizeGB: number): number {
  if (modelSizeGB <= 0) return 64;
  if (modelSizeGB < 8) return 40;
  if (modelSizeGB < 14) return 64;
  return Math.min(128, 32 + modelSizeGB * 4);
}

export interface MemoryBudgetBreakdown {
  gpuBudgetGB: number;
  modelGB: number;
  headroomGB: number;
  kvBudgetGB: number;
  tight: boolean;
}

/** Pure budget math shared by tests and recommend(). */
export function computeMemoryBudget(profile: MachineProfile, modelSizeGB: number): MemoryBudgetBreakdown {
  const total = profile.totalRamGB ?? profile.memory?.totalGB ?? 0;
  const wiredRaw = profile.gpuWiredLimitUsesSystemDefault ? 0 : profile.gpuWiredLimitMB;
  const { budgetGB: gpuBudgetGB } = effectiveGpuMemoryBudgetGB(total, wiredRaw);
  const mem = profile.memory;
  const available = mem?.availableGB ?? 0;
  let headroomFrac = 0.15;
  if (mem?.pressure === 'warn') headroomFrac = 0.25;
  if (mem?.pressure === 'critical') headroomFrac = 0.35;
  let swapReserveGB = 0;
  if ((mem?.swapUsedGB ?? 0) > 0.25) swapReserveGB = 4;
  if ((mem?.swapUsedGB ?? 0) > 2) swapReserveGB = 10;
  const headroomGB = gpuBudgetGB * headroomFrac + swapReserveGB;
  const modelGB = Math.max(0, modelSizeGB);
  const afterModel = Math.max(0, gpuBudgetGB - modelGB);
  const kvBudgetGB = Math.max(0, Math.min(available, afterModel) - headroomGB);
  const tight = mem?.pressure === 'warn' || mem?.pressure === 'critical' || swapReserveGB > 0 || kvBudgetGB < 8;
  return { gpuBudgetGB, modelGB, headroomGB, kvBudgetGB, tight };
}

function pushReco(out: SettingRecommendation[], key: string, recommended: number, reason: string, current: number): void {
  out.push({ settingKey: key, recommended, reason });
}

/**
 * Suggests performance-related Forge settings from a read-only machine profile.
 * Numbers are explained in plain language in each `reason`.
 */
export function recommend(profile: MachineProfile, current: RecommendSettingsInput, modelInfo?: ModelInfoForRecommend): SettingRecommendation[] {
  const out: SettingRecommendation[] = [];
  const modelGB = modelInfo?.modelSizeGB ?? profile.loadedModelSizeGB ?? 0;
  const budget = computeMemoryBudget(profile, modelGB);
  const ctxKey = current.provider === 'ollama' ? 'numCtx' : 'numCtx';

  const kvBytes = kvBytesPerToken(modelGB);
  let ctxFromMem = budget.kvBudgetGB > 0 ? Math.floor((budget.kvBudgetGB * GB) / kvBytes) : 8192;
  ctxFromMem = roundStep(ctxFromMem, 4096);
  ctxFromMem = Math.max(8192, Math.min(ctxFromMem, 262144));
  if (modelInfo?.maxContextTokens) ctxFromMem = Math.min(ctxFromMem, modelInfo.maxContextTokens);
  if (budget.tight) ctxFromMem = Math.min(ctxFromMem, Math.max(8192, roundStep(current.numCtx * 0.75, 4096)));

  const ctxReasonParts = [
    `About ${budget.kvBudgetGB.toFixed(1)} GB is left for KV cache after ~${budget.modelGB.toFixed(1)} GB model weights and ~${budget.headroomGB.toFixed(1)} GB headroom`,
    profile.gpuWiredLimitUsesSystemDefault
      ? `GPU budget assumes macOS default wired limit (~75% of ${profile.totalRamGB ?? '?'} GB RAM because sysctl reports 0)`
      : `GPU wired limit is ${profile.gpuWiredLimitMB} MB`,
  ];
  if ((profile.memory?.swapUsedGB ?? 0) > 0.25) ctxReasonParts.push('swap is in use, so context is kept conservative');
  if (profile.memory?.pressure === 'warn' || profile.memory?.pressure === 'critical') {
    ctxReasonParts.push(`memory pressure is ${profile.memory?.pressure}`);
  }
  pushReco(out, ctxKey, ctxFromMem, `${ctxReasonParts.join('; ')}.`, current.numCtx);

  const cacheGB = budget.tight
    ? Math.max(2, Math.min(8, roundStep(budget.kvBudgetGB * 0.08, 0.5)))
    : Math.max(4, Math.min(64, roundStep(Math.min(budget.kvBudgetGB * 0.2, profile.totalRamGB ? profile.totalRamGB * 0.15 : 32), 0.5)));
  pushReco(
    out,
    'mlx.promptCacheGB',
    cacheGB,
    budget.tight
      ? `Memory is tight — a smaller prompt cache (${cacheGB} GB) leaves more room for the live context.`
      : `With ~${budget.kvBudgetGB.toFixed(1)} GB KV headroom, ${cacheGB} GB for MLX prompt cache is a balanced share of spare unified memory.`,
    current.mlxPromptCacheGB
  );

  const cacheEntries = budget.tight ? 64 : budget.kvBudgetGB > 40 ? 512 : 256;
  pushReco(
    out,
    'mlx.promptCacheSize',
    cacheEntries,
    budget.tight
      ? 'Fewer distinct cached prompts when RAM is scarce avoids evicting useful entries.'
      : 'More cache entries help reuse long prefixes during agent loops when memory is plentiful.',
    current.mlxPromptCacheSize
  );

  const prefill = budget.tight ? 1024 : budget.kvBudgetGB > 24 ? 8192 : 4096;
  pushReco(
    out,
    'mlx.prefillStepSize',
    prefill,
    budget.tight
      ? 'Smaller prefill steps reduce peak memory spikes while the machine is under pressure.'
      : 'Larger prefill steps improve throughput when plenty of unified memory is free.',
    current.mlxPrefillStepSize
  );

  const autoOut = resolveEffectiveMaxOutputTokens(0, ctxFromMem, 0);
  const outRec = current.maxOutputTokens > 0 ? current.maxOutputTokens : 0;
  const ceilingRec = budget.tight ? Math.min(32768, autoOut) : Math.max(0, current.maxOutputTokensCeiling || 0);
  pushReco(
    out,
    'maxOutputTokens',
    outRec,
    outRec === 0
      ? `Auto mode already yields up to ${autoOut.toLocaleString()} tokens for a ${ctxFromMem.toLocaleString()}-token window (half the context, floor 16k).`
      : 'Explicit max output is set — recommendation keeps your value unless you switch back to 0 (auto).',
    current.maxOutputTokens
  );
  pushReco(
    out,
    'maxOutputTokensCeiling',
    ceilingRec,
    ceilingRec === 0
      ? 'No ceiling on auto output — appropriate when memory is comfortable.'
      : `Cap auto output at ${ceilingRec.toLocaleString()} tokens while memory is ${budget.tight ? 'tight' : 'ample'}.`,
    current.maxOutputTokensCeiling
  );

  const keepAlive = budget.tight ? (profile.memory?.pressure === 'critical' ? 5 : 30) : -1;
  pushReco(
    out,
    'keepAliveMinutes',
    keepAlive,
    keepAlive < 0
      ? 'Plenty of free memory — keep the model loaded (-1) to avoid reload and KV rebuild cost.'
      : 'Unload sooner when memory or swap pressure is high so other work can breathe.',
    current.keepAliveMinutes
  );

  const fileKb = Math.min(8192, Math.max(512, roundStep((ctxFromMem / 16) * 0.75, 64)));
  pushReco(
    out,
    'maxContextFileKB',
    fileKb,
    `Scale file read cap with context (~${ctxFromMem.toLocaleString()} tokens) so large sources can be indexed without exceeding the window.`,
    current.maxContextFileKB
  );

  return out;
}
