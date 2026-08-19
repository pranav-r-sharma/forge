import * as os from 'os';
import * as childProcess from 'child_process';
const execFile: (command: string, args: string[], options: any, callback: (err: any, stdout: string, stderr: string) => void) => void = childProcess.execFile as any;

/** Item "HWD metrics... ram usage": system RAM via Node's built-in os module — no external dependency, always available on every platform. */
export function getRamStatus(): { usedGB: number; totalGB: number } {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    usedGB: round1((totalBytes - freeBytes) / 1024 / 1024 / 1024),
    totalGB: round1(totalBytes / 1024 / 1024 / 1024),
  };
}

/**
 * Item "lot of ram sitting idle, can that be somehow leveraged for
 * increased context": a ROUGH, clearly-labeled heuristic suggestion for
 * how much headroom might exist to raise forge.numCtx, based purely on
 * currently-idle system RAM.
 *
 * This is deliberately NOT a precise calculation. The actual memory cost
 * of the KV cache Ollama allocates for a given num_ctx depends on
 * model-specific architecture details (layer count, hidden dimension,
 * attention head layout, quantization) that Forge has no way to query
 * from the Ollama HTTP API — GET /api/ps reports a model's total resident
 * size, not how that breaks down between weights and KV cache. A formula
 * that claimed to compute an exact "safe" num_ctx from RAM alone would be
 * pretending to a precision it doesn't have. Instead this offers a
 * conservative, order-of-magnitude suggestion: scale the CURRENT num_ctx
 * up in proportion to how much RAM is sitting idle right now, using only
 * a fraction of that idle RAM (KV cache isn't the only thing that will
 * grow to use freed memory — the OS, other apps, and any additional
 * models Ollama loads all need headroom too). The caller is expected to
 * present this as a starting point to try and watch, via the HW panel,
 * not a guarantee it will fit.
 *
 * Returns undefined when there isn't enough idle RAM to make a
 * suggestion worthwhile — avoids noisy "try 8192 -> 8500"-ish
 * non-suggestions when the machine is already nearly full.
 */
export function estimateSuggestedNumCtx(currentNumCtx: number, ram: { usedGB: number; totalGB: number }): number | undefined {
  if (!currentNumCtx || currentNumCtx <= 0 || !ram.totalGB) return undefined;
  const freeGB = Math.max(0, ram.totalGB - ram.usedGB);
  const idleFraction = freeGB / ram.totalGB;
  // Require at least ~2GB AND at least 20% of total RAM idle before
  // suggesting anything -- below that the "headroom" is just normal
  // OS/app breathing room, not something worth handing to Ollama.
  if (freeGB < 2 || idleFraction < 0.2) return undefined;
  // Conservative: only offer up to half of the idle fraction as extra
  // context headroom.
  const growthFactor = 1 + idleFraction * 0.5;
  const rounded = Math.round((currentNumCtx * growthFactor) / 1024) * 1024;
  const capped = Math.min(rounded, 131072);
  return capped > currentNumCtx ? capped : undefined;
}

export interface GpuStatus {
  name: string;
  usedVramGB: number;
  totalVramGB: number;
  utilizationPct: number;
}

/**
 * Item "HWD metrics... gpu usage": best-effort GPU readout via `nvidia-smi`.
 * There is no cross-vendor/cross-platform way to query GPU utilization
 * without adding a runtime dependency (which this extension deliberately
 * avoids — see README's zero-dependency architecture note), so this only
 * ever succeeds on a machine with an NVIDIA GPU and the driver's CLI tool
 * on PATH. On Apple Silicon / AMD / no discrete GPU / nvidia-smi missing,
 * this resolves to an empty array rather than throwing — the composer
 * footer simply omits the GPU readout in that case, which is the common
 * case for a local-Ollama laptop setup and not itself an error condition.
 * (Ollama's own per-model VRAM figure from GET /api/ps, surfaced separately
 * as loadedModels[].vramGB, still works everywhere Ollama itself reports it.)
 */
export function getGpuStatus(timeoutMs = 1500): Promise<GpuStatus[]> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GpuStatus[]) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
        { timeout: timeoutMs },
        (err: any, stdout: string) => {
          clearTimeout(timer);
          if (err || !stdout) {
            finish([]);
            return;
          }
          try {
            const rows: GpuStatus[] = stdout
              .trim()
              .split('\n')
              .map((line: string) => line.trim())
              .filter(Boolean)
              .map((line: string) => {
                const [name, usedMiB, totalMiB, util] = line.split(',').map((s: string) => s.trim());
                return {
                  name,
                  usedVramGB: Math.round((parseFloat(usedMiB) / 1024) * 10) / 10,
                  totalVramGB: Math.round((parseFloat(totalMiB) / 1024) * 10) / 10,
                  utilizationPct: Math.round(parseFloat(util)),
                };
              })
              .filter((g: GpuStatus) => !Number.isNaN(g.usedVramGB) && !Number.isNaN(g.totalVramGB));
            finish(rows);
          } catch {
            finish([]);
          }
        }
      );
    } catch {
      clearTimeout(timer);
      finish([]);
    }
  });
}
