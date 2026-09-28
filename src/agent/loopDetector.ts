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
 * Three independent signals, any one trips it:
 * 1. The exact same signature N times in a row (`consecutiveLimit`) — the
 *    model is repeating itself verbatim.
 * 2. The exact same signature appears >= `windowLimit` times within the
 *    last `windowSize` calls — it keeps coming back to the same failing
 *    move even if something else happens in between.
 * 3. The last 16 signatures use at most four distinct values — the model is
 *    cycling through the same few calls (e.g. four chunked reads on repeat).
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
  /** When set, use this key for warn-once-then-stop (e.g. cycle detection across rotating signatures). */
  warnSignature?: string;
}

const CYCLE_HISTORY_SIZE = 16;
const CYCLE_MAX_DISTINCT = 4;

export class LoopDetector {
  private history: string[] = [];
  private cycleHistory: string[] = [];
  private readonly consecutiveLimit: number;
  private readonly windowSize: number;
  private readonly windowLimit: number;
  /** Signatures that already received a one-time loop warning (second trip stops). */
  private warnedSignatures = new Set<string>();

  constructor(opts: LoopDetectorOptions = {}) {
    this.consecutiveLimit = opts.consecutiveLimit ?? 3;
    this.windowSize = opts.windowSize ?? 8;
    this.windowLimit = opts.windowLimit ?? 4;
  }

  hasWarnedForSignature(signature: string): boolean {
    return this.warnedSignatures.has(signature);
  }

  markWarnedForSignature(signature: string): void {
    this.warnedSignatures.add(signature);
  }

  /** Records one step's signature and reports whether the run now looks like a loop. */
  record(signature: string): LoopCheckResult {
    this.history.push(signature);
    if (this.history.length > this.windowSize) this.history = this.history.slice(-this.windowSize);
    this.cycleHistory.push(signature);
    if (this.cycleHistory.length > CYCLE_HISTORY_SIZE) this.cycleHistory = this.cycleHistory.slice(-CYCLE_HISTORY_SIZE);

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

    if (this.cycleHistory.length >= CYCLE_HISTORY_SIZE) {
      const distinct = [...new Set(this.cycleHistory)];
      if (distinct.length <= CYCLE_MAX_DISTINCT) {
        const warnSignature = `cycle:${distinct.slice().sort().join('|')}`;
        return {
          looping: true,
          occurrences: this.cycleHistory.length,
          reason: 'cycling through the same few calls',
          warnSignature,
        };
      }
    }

    return { looping: false };
  }

  reset() {
    this.history = [];
    this.cycleHistory = [];
    this.warnedSignatures.clear();
  }
}

/** Human-readable target for a repeated tool call (path, command, etc.). */
export function loopTargetForTool(tool: string, args: Record<string, any>): string {
  if (tool === 'run_command' && typeof args.command === 'string') return args.command;
  if (typeof args.path === 'string') return args.path;
  if (typeof args.file === 'string') return args.file;
  if (typeof args.query === 'string') return args.query;
  if (typeof args.url === 'string') return args.url;
  if (typeof args.command === 'string') return args.command;
  return JSON.stringify(args);
}

/** First line of a tool result, trimmed for the loop-warning nudge. */
export function firstLineOfToolResult(content: string): string {
  const line = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? content;
  return line.trim().slice(0, 200);
}

export function formatLoopWarningMessage(
  tool: string,
  args: Record<string, any>,
  occurrences: number,
  resultContent: string,
  failingCommand?: { command: string; exitCode?: number; snippet?: string },
): string {
  const target = loopTargetForTool(tool, args);
  const outcome = firstLineOfToolResult(resultContent);
  let msg = `[System check] You have sent the same ${tool} on \`${target}\` ${occurrences} times; it changed nothing (${outcome}).`;
  if (failingCommand) {
    const code = failingCommand.exitCode !== undefined ? failingCommand.exitCode : '?';
    const err = failingCommand.snippet ?? '';
    msg += ` The command still failing is \`${failingCommand.command}\` (exit ${code}): ${err}`;
  }
  msg += ' Do something different: read the error, then change the code that causes it.';
  return msg;
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
