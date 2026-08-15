/**
 * Minimal dependency-free line diff (Myers algorithm) used to build the diff
 * views for inline edits and agent-proposed file changes, and to render a
 * compact unified-diff preview inside the chat trace.
 */

export interface DiffOp {
  type: 'equal' | 'add' | 'del';
  line: string;
}

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const vSize = 2 * max + 1;
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(vSize);
  let found = false;
  let dFound = 0;

  outer: for (let d = 0; d <= max; d++) {
    const snapshot = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(snapshot);
        found = true;
        dFound = d;
        break outer;
      }
    }
    trace.push(snapshot);
  }

  if (!found) {
    // Fallback: shouldn't happen, but degrade to a full replace rather than throw.
    const ops: DiffOp[] = [];
    for (const line of a) ops.push({ type: 'del', line });
    for (const line of b) ops.push({ type: 'add', line });
    return ops;
  }

  // Backtrack to build the op list.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ type: 'add', line: b[y - 1] });
      y--;
    } else {
      ops.push({ type: 'del', line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', line: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ type: 'del', line: a[x - 1] });
    x--;
  }
  while (y > 0) {
    ops.push({ type: 'add', line: b[y - 1] });
    y--;
  }

  ops.reverse();
  return ops;
}

export interface UnifiedDiffResult {
  text: string;
  additions: number;
  deletions: number;
}

export function unifiedDiff(oldText: string, newText: string, contextLines = 3): UnifiedDiffResult {
  const ops = diffLines(oldText, newText);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === 'add') additions++;
    else if (op.type === 'del') deletions++;
  }

  // Group into hunks with surrounding context, mirroring `diff -u` output.
  const lines: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') {
      i++;
      continue;
    }
    // Found a change; walk backward to include leading context.
    let start = i;
    let contextBack = 0;
    while (start > 0 && ops[start - 1].type === 'equal' && contextBack < contextLines) {
      start--;
      contextBack++;
    }
    // Walk forward collecting the hunk until a gap of >2*contextLines equal lines.
    let end = i;
    let equalRun = 0;
    while (end < ops.length) {
      if (ops[end].type === 'equal') {
        equalRun++;
        if (equalRun > contextLines * 2) break;
      } else {
        equalRun = 0;
      }
      end++;
    }
    // Trim trailing equal run down to contextLines.
    let trimEnd = end;
    let trailingEqual = 0;
    while (trimEnd > start && ops[trimEnd - 1].type === 'equal') {
      trailingEqual++;
      trimEnd--;
      if (trailingEqual >= contextLines) break;
    }
    trimEnd = Math.max(trimEnd, i + 1);

    const hunk = ops.slice(start, Math.min(end, ops.length));
    for (const op of hunk) {
      const prefix = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
      lines.push(prefix + op.line);
    }
    i = end;
  }

  return { text: lines.join('\n'), additions, deletions };
}
