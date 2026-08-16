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
