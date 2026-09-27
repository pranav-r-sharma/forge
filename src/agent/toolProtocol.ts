import { ToolCall } from './types';

const FENCED_BLOCK_RE = /```(?:forge_action|forge-action|json)?\s*\n([\s\S]*?)```/gi;
const FENCE_OPEN_RE = /```(?:forge_action|forge-action|json)?\s*\n/gi;

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

type ParsedToolJson = { tool: string; args: Record<string, any>; jsonRepaired?: boolean };

function tryParseToolJson(text: string): ParsedToolJson | null {
  let candidate = text.trim();
  // Some models wrap the JSON again in a nested fence or prefix it with "Action:" etc.
  candidate = candidate.replace(/^[^{]*(\{[\s\S]*\})[^}]*$/, '$1');
  const direct = parseToolJsonObject(candidate);
  if (direct) return direct;
  const repaired = tryRepairMissingJsonClosers(candidate);
  if (repaired && repaired !== candidate) {
    const parsed = parseToolJsonObject(repaired);
    if (parsed) return { ...parsed, jsonRepaired: true };
  }
  return null;
}

function parseToolJsonObject(candidate: string): ParsedToolJson | null {
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object' && typeof obj.tool === 'string') {
      const args = obj.args && typeof obj.args === 'object' ? obj.args : {};
      return { tool: obj.tool, args };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * If every string literal is closed and the only defect is missing `}` / `]` at the end
 * (≤3 closers), append them in stack order. Never repairs broken strings or extra/missing
 * brackets in the middle.
 */
export function tryRepairMissingJsonClosers(text: string): string | null {
  const trimmed = text.trim();
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      stack.push('{');
    } else if (ch === '[') {
      stack.push('[');
    } else if (ch === '}') {
      if (stack.length === 0 || stack[stack.length - 1] !== '{') return null;
      stack.pop();
    } else if (ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== '[') return null;
      stack.pop();
    }
  }
  if (inString || stack.length === 0 || stack.length > 3) return null;
  const suffix = stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  return trimmed + suffix;
}

/** True when the last forge_action/json fence in `raw` has a closing ```. */
export function isForgeActionFenceClosed(raw: string): boolean {
  let lastOpen = -1;
  FENCE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_OPEN_RE.exec(raw))) lastOpen = m.index;
  if (lastOpen === -1) return false;
  const afterOpen = raw.slice(lastOpen);
  const nl = afterOpen.indexOf('\n');
  if (nl === -1) return false;
  return afterOpen.slice(nl + 1).includes('```');
}

/** Body of the last fenced forge_action/json block, if any. */
export function extractForgeActionFenceBody(raw: string): string | null {
  FENCED_BLOCK_RE.lastIndex = 0;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = FENCED_BLOCK_RE.exec(raw))) last = m[1].trim();
  return last;
}

/** JSON.parse error text plus ~40 chars around the reported position (for nudge messages). */
export function forgeActionJsonParseErrorDetail(body: string): { message: string; near: string } {
  const trimmed = body.trim();
  try {
    JSON.parse(trimmed);
    return { message: 'invalid JSON', near: trimmed.slice(0, 40) };
  } catch (e: any) {
    const rawMsg = (e?.message ?? String(e)).replace(/^JSON\.parse error:\s*/i, '').trim();
    const posMatch = /position (\d+)/i.exec(rawMsg);
    const pos = posMatch ? parseInt(posMatch[1], 10) : trimmed.length;
    const start = Math.max(0, pos - 20);
    const end = Math.min(trimmed.length, pos + 20);
    const near = trimmed.slice(start, end).replace(/\s+/g, ' ');
    return { message: rawMsg, near };
  }
}

/** Strips the forge_action block out of assistant text, for showing a clean "thought" line in the trace. */
export function stripActionBlock(raw: string): string {
  return raw.replace(FENCED_BLOCK_RE, '').trim();
}

/**
 * True when `raw` looks like it was trying to be a tool call (contains a `"tool":"..."` fragment)
 * but `parseToolCall(raw)` still returned null — i.e. the model started a forge_action JSON object
 * and never finished it (e.g. it emitted a stop token mid-string on a long `write_file`), rather than
 * writing a genuine final answer that just happens not to invoke a tool. Only meaningful when the
 * caller has already confirmed `parseToolCall(raw)` returned null: if a `"tool"` fragment fully
 * parsed, `parseToolCall` would have returned a real call and this check is moot.
 */
export function looksLikeAbandonedToolCall(raw: string): boolean {
  return /"tool"\s*:\s*"/.test(raw);
}

export type AbandonedActionTarget = { tool: string; path?: string };

const JSON_STRING_IN_QUOTES = '"((?:[^"\\\\]|\\\\.)*)"';

/** Pull tool name (and path when fully quoted) from a partial forge_action JSON fragment. */
export function extractAbandonedActionTarget(raw: string): AbandonedActionTarget | undefined {
  const toolRe = new RegExp(`"tool"\\s*:\\s*${JSON_STRING_IN_QUOTES}`, 'g');
  let lastTool: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = toolRe.exec(raw)) !== null) lastTool = m;
  if (!lastTool) return undefined;
  const tool = decodeJsonStringFragment(lastTool[1]);
  const afterLastTool = raw.slice(lastTool.index);
  const pathMatch = new RegExp(`"path"\\s*:\\s*${JSON_STRING_IN_QUOTES}`).exec(afterLastTool);
  if (!pathMatch) return { tool };
  return { tool, path: decodeJsonStringFragment(pathMatch[1]) };
}

function decodeJsonStringFragment(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    if (ch === '"') return '"';
    if (ch === '\\') return '\\';
    return ch;
  });
}

/** User nudge when a reply was length-truncated or abandoned mid-action. Exported for unit tests. */
const INCOMPLETE_NUDGE_REASONING_HINT =
  ' Do not repeat your analysis; keep any reasoning to a couple of sentences.';

export function formatIncompleteActionNudge(raw: string, lengthTruncated: boolean): string {
  const target = extractAbandonedActionTarget(raw);
  const fenceClosed = isForgeActionFenceClosed(raw);
  const fenceBody = extractForgeActionFenceBody(raw);

  const fenceBodyStrictFail =
    fenceBody &&
    parseToolJsonObject(fenceBody) === null &&
    !(tryRepairMissingJsonClosers(fenceBody) && parseToolJsonObject(tryRepairMissingJsonClosers(fenceBody)!));
  if (target && !lengthTruncated && fenceClosed && fenceBodyStrictFail) {
    const err = forgeActionJsonParseErrorDetail(fenceBody!);
    const pathPart = target.path ? ` on \`${target.path}\`` : '';
    return `[System check] Your forge_action for ${target.tool}${pathPart} is not valid JSON: ${err.message}, near: ${err.near}. Resend that exact action with valid JSON.${INCOMPLETE_NUDGE_REASONING_HINT}`;
  }

  if (target) {
    if (target.path) {
      const cutOff = lengthTruncated || !fenceClosed;
      if (cutOff) {
        return `[System check] You were in the middle of ${target.tool} on \`${target.path}\` and the reply was cut off. Finish that exact action on \`${target.path}\` now, in one forge_action block. Do not move on to a different file or action until it is done.${INCOMPLETE_NUDGE_REASONING_HINT}`;
      }
    }
    const cutOff = lengthTruncated || !fenceClosed;
    if (cutOff) {
      return `[System check] You were in the middle of ${target.tool} and the reply was cut off. Finish that exact ${target.tool} action now, in one forge_action block. Do not move on to a different action until it is done.${INCOMPLETE_NUDGE_REASONING_HINT}`;
    }
  }
  const reason = lengthTruncated
    ? 'Your last reply was cut off by the output-length limit before you finished, so it was not a complete action or answer.'
    : 'Your last reply started an action but the JSON was left incomplete, so it was not a valid action or answer.';
  return `[System check] ${reason} Do not repeat your analysis. Keep any reasoning to a couple of sentences and reply now with your next action (one forge_action block) or, if the task is complete, your final answer.`;
}

/** Final user-visible note when incomplete-action nudges are exhausted. Exported for tests. */
export function formatIncompleteActionCapFailure(raw: string, attempts: number): string {
  const target = extractAbandonedActionTarget(raw);
  const tool = target?.tool ?? 'tool';
  const path = target?.path ?? 'unknown path';
  return `stopped: could not produce a valid action for ${tool} on ${path} after ${attempts} attempts`;
}
