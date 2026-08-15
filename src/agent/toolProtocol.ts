import { ToolCall } from './types';

const FENCED_BLOCK_RE = /```(?:forge_action|forge-action|json)?\s*\n([\s\S]*?)```/gi;

/**
 * Extracts the model's tool call from its raw response text, per the
 * contract in systemPrompt.ts. Written defensively since local models —
 * especially smaller ones — sometimes drift from the exact fence format:
 * 1. Prefer a properly fenced ```forge_action block.
 * 2. Fall back to any fenced block whose contents parse as {"tool": ...}.
 * 3. Fall back to a bare {"tool": ...} JSON object anywhere in the text.
 * Returns null when the text should be treated as a final answer.
 */
export function parseToolCall(raw: string): ToolCall | null {
  const candidates: string[] = [];

  let m: RegExpExecArray | null;
  FENCED_BLOCK_RE.lastIndex = 0;
  while ((m = FENCED_BLOCK_RE.exec(raw))) {
    candidates.push(m[1].trim());
  }

  for (const c of candidates) {
    const parsed = tryParseToolJson(c);
    if (parsed) return { ...parsed, raw };
  }

  // Last resort: hunt for a bare JSON object containing a "tool" key, in
  // case the model forgot the code fence entirely. Uses brace-balanced
  // scanning (not a regex) because "args" is almost always itself a nested
  // object, which a naive non-greedy regex truncates at the first inner `}`.
  const bare = findBalancedJsonWithTool(raw);
  if (bare) {
    const parsed = tryParseToolJson(bare);
    if (parsed) return { ...parsed, raw };
  }

  return null;
}

/** Scans for the first `{...}` span (respecting string literals) whose top level has a "tool" key. */
function findBalancedJsonWithTool(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = findMatchingBrace(text, i);
    if (end === -1) continue;
    const candidate = text.slice(i, end + 1);
    if (/"tool"\s*:\s*"[^"]+"/.test(candidate)) return candidate;
  }
  return null;
}

/** Returns the index of the `}` matching the `{` at `start`, respecting quoted strings, or -1. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParseToolJson(text: string): { tool: string; args: Record<string, any> } | null {
  let candidate = text.trim();
  // Some models wrap the JSON again in a nested fence or prefix it with "Action:" etc.
  candidate = candidate.replace(/^[^{]*(\{[\s\S]*\})[^}]*$/, '$1');
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object' && typeof obj.tool === 'string') {
      return { tool: obj.tool, args: (obj.args && typeof obj.args === 'object') ? obj.args : {} };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Strips the forge_action block out of assistant text, for showing a clean "thought" line in the trace. */
export function stripActionBlock(raw: string): string {
  return raw.replace(FENCED_BLOCK_RE, '').trim();
}
