/**
 * Detects a stuck/thrashing agent turn: the same tool call producing the
 * same (or near-identical) result, over and over, with no progress.
 *
 * This exists because two other changes in this release remove softer
 * safety nets: `maxAgentIterations` went from a conservative 25 to a much
 * more generous default (so real long tasks don't get cut off early), and
 * Auto mode (fully autonomous, no approvals) can run for up to
 * `autoModeMaxIterations` steps unattended. Without something actively
 * watching for repetition, a model stuck calling the same failing tool
 * would previously "just" hit the iteration cap after 25 steps — now it
 * could burn a very long time doing nothing useful. The loop detector is
 * the thing that actually notices and stops that, rather than a raw counter.
 *
 * Two independent signals, either one trips it:
 * 1. The exact same signature N times in a row (`consecutiveLimit`) — the
 *    model is repeating itself verbatim.
 * 2. The exact same signature appears >= `windowLimit` times within the
 *    last `windowSize` calls — it keeps coming back to the same failing
 *    move even if something else happens in between.
 */
export interface LoopDetectorOptions {
  consecutiveLimit?: number;
  windowSize?: number;
  windowLimit?: number;
}

export interface LoopCheckResult {
  looping: boolean;
  reason?: string;
  occurrences?: number;
}

export class LoopDetector {
  private history: string[] = [];
  private readonly consecutiveLimit: number;
  private readonly windowSize: number;
  private readonly windowLimit: number;

  constructor(opts: LoopDetectorOptions = {}) {
    this.consecutiveLimit = opts.consecutiveLimit ?? 3;
    this.windowSize = opts.windowSize ?? 8;
    this.windowLimit = opts.windowLimit ?? 4;
  }

  /** Records one step's signature and reports whether the run now looks like a loop. */
  record(signature: string): LoopCheckResult {
    this.history.push(signature);
    if (this.history.length > this.windowSize) this.history = this.history.slice(-this.windowSize);

    let consecutive = 0;
    for (let i = this.history.length - 1; i >= 0 && this.history[i] === signature; i--) consecutive++;
    if (consecutive >= this.consecutiveLimit) {
      return {
        looping: true,
        occurrences: consecutive,
        reason: `The same action repeated ${consecutive} times in a row with no change in outcome.`,
      };
    }

    const inWindow = this.history.filter((s) => s === signature).length;
    if (inWindow >= this.windowLimit) {
      return {
        looping: true,
        occurrences: inWindow,
        reason: `The same action recurred ${inWindow} times in the last ${this.history.length} steps without making progress.`,
      };
    }

    return { looping: false };
  }

  reset() {
    this.history = [];
  }
}

/** Builds a stable signature for one tool-call step, used as LoopDetector's input. Two calls with the same tool+args+outcome+result-shape collapse to the same signature. */
export function signatureForStep(tool: string, args: Record<string, any>, ok: boolean, resultContent: string): string {
  const normalizedArgs = stableStringify(args);
  // Only the result's *shape* matters for loop detection (same length bucket
  // + same ok/fail), not its exact text — a command that fails with a
  // timestamp in the output would otherwise never look like a repeat.
  const resultBucket = `${ok ? 'ok' : 'fail'}:${Math.min(9, Math.floor(resultContent.length / 200))}:${resultContent.slice(0, 60)}`;
  return `${tool}|${normalizedArgs}|${resultBucket}`;
}

function stableStringify(obj: Record<string, any>): string {
  const keys = Object.keys(obj).sort();
  return JSON.stringify(obj, keys);
}
