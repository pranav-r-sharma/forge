/**
 * Tracks which line ranges of which files the model has already been shown this turn, so a repeat read can be recognized.
 * Pure (no vscode, no I/O). First user: the trace log's `redundantRead` flag, which is how the v0.15.0 plan measures the
 * "reads the whole file several times instead of using grep" problem (§1.2). Later user: the read ledger that answers
 * "unchanged since you last read it" instead of re-sending content (§3.2).
 *
 * A read is REDUNDANT when every requested line is already covered by earlier reads AND nothing has invalidated that
 * coverage since (a write to the file, or a shell command that might have changed anything). A whole-file read is treated as covering
 * [1, Infinity), and a whole-file request is only redundant if an earlier whole-file read is still valid.
 */
export interface ReadRequest {
  path: string;
  /** 1-indexed inclusive; omitted = from the first line. */
  startLine?: number;
  /** 1-indexed inclusive; omitted = to the end of the file. */
  endLine?: number;
}

export interface ReadNote {
  redundant: boolean;
  /** 0..1 — share of the requested lines already covered. For an unbounded (whole-file) request this is 1 only if a whole-file read is still valid, else 0. */
  coveredFraction: number;
}

const END = Number.MAX_SAFE_INTEGER;

export class ReadCoverage {
  private ranges = new Map<string, [number, number][]>();

  /** Records a read and reports whether it was redundant. Call this AFTER the read succeeded. */
  note(req: ReadRequest): ReadNote {
    const s = Math.max(1, Math.floor(req.startLine ?? 1));
    const e = req.endLine === undefined ? END : Math.max(s, Math.floor(req.endLine));
    const existing = this.ranges.get(req.path) ?? [];
    const covered = overlap(existing, s, e);
    const total = e === END ? END - s + 1 : e - s + 1;
    const coveredFraction = e === END ? (covered >= total ? 1 : 0) : Math.min(1, covered / total);
    this.ranges.set(req.path, merge([...existing, [s, e]]));
    return { redundant: coveredFraction >= 1, coveredFraction };
  }

  /** Forget everything known about one file (call after a write to it). */
  invalidate(path: string): void {
    this.ranges.delete(path);
  }

  /** Forget everything (call after a command that could have changed any file). */
  clear(): void {
    this.ranges.clear();
  }
}

function merge(rs: [number, number][]): [number, number][] {
  const sorted = rs.slice().sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function overlap(rs: [number, number][], s: number, e: number): number {
  let n = 0;
  for (const [a, b] of rs) {
    const lo = Math.max(a, s);
    const hi = Math.min(b, e);
    if (hi >= lo) n += hi - lo + 1;
  }
  return n;
}
