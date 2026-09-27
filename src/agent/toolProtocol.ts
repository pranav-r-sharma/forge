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

  // Bare {"tool":...} outside a fence is a native tool-call shape — not executed here;
  // detectForeignToolCall() nudges the model to use ```forge_action instead.

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

type ParsedToolJson = { tool: string; args: Record<string, any> };

function tryParseToolJson(text: string): ParsedToolJson | null {
  let candidate = text.trim();
  // Some models wrap the JSON again in a nested fence or prefix it with "Action:" etc.
  candidate = candidate.replace(/^[^{]*(\{[\s\S]*\})[^}]*$/, '$1');
  return parseToolJsonObject(candidate);
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

  const fenceBodyStrictFail = fenceBody && parseToolJsonObject(fenceBody) === null;
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

const HARMONY_MARKER = /<\|(?:channel|message|start|end|constrain)\|>/;

/** True when the text uses Harmony-style control tokens (`<|channel|>`, etc.). */
export function containsHarmonyControls(raw: string): boolean {
  return HARMONY_MARKER.test(raw);
}

/** Removes Harmony control tokens from text shown or stored as the answer. */
export function stripHarmonyControlTokens(text: string): string {
  return text.replace(/<\|[^|]+\|>/g, '').replace(/\s+/g, ' ').trim();
}

export type PreprocessedModelReply = {
  /** Text passed to forge_action / foreign-tool parsing. */
  textForParsing: string;
  /** User-visible answer text (no analysis channel, no control tokens). */
  displayText: string;
  /** Analysis-channel content, when present (same role as streaming "reasoning"). */
  reasoning: string;
};

/**
 * Splits Harmony-channel replies: analysis → reasoning; final → displayText;
 * strips control tokens from anything shown as the answer.
 */
export function preprocessHarmonyReply(raw: string): PreprocessedModelReply {
  if (!containsHarmonyControls(raw)) {
    return { textForParsing: raw, displayText: raw, reasoning: '' };
  }

  const reasoningParts: string[] = [];
  const analysisRe = /<\|channel\|>analysis<\|message\|>([\s\S]*?)<\|end\|>/gi;
  let m: RegExpExecArray | null;
  while ((m = analysisRe.exec(raw)) !== null) {
    const t = m[1].trim();
    if (t) reasoningParts.push(t);
  }

  const finalParts: string[] = [];
  const finalRe = /<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|end\|>|(?=<\|start\|>)|$)/gi;
  while ((m = finalRe.exec(raw)) !== null) {
    const t = stripHarmonyControlTokens(m[1]);
    if (t) finalParts.push(t);
  }

  const displayText = finalParts.join('\n').trim();
  return {
    textForParsing: raw,
    displayText,
    reasoning: reasoningParts.join('\n').trim(),
  };
}

export type ForeignToolCallFormat =
  | 'harmony-commentary'
  | 'xml-tool-call'
  | 'openai-name-arguments'
  | 'bare-tool-json';

export type ForeignToolCall = { tool: string; args: Record<string, unknown> | null; format: ForeignToolCallFormat };

const FORGE_ACTION_WRAPPER_NAMES = new Set(['forge_action', 'functions.forge_action']);

/** Canonical forge_action block for the model-facing transcript (no Harmony control tokens). */
export function formatToolCallForHistory(call: { tool: string; args: Record<string, unknown> }): string {
  return '```forge_action\n' + JSON.stringify({ tool: call.tool, args: call.args }) + '\n```';
}

/**
 * When detectForeignToolCall finds a complete native call, map it to a Forge ToolCall — strict parse only, no repair.
 */
export function tryAcceptNativeToolCall(
  foreign: ForeignToolCall,
  knownTools: string[]
): { call: ToolCall; format: ForeignToolCallFormat } | null {
  if (foreign.args === null) return null;

  if (FORGE_ACTION_WRAPPER_NAMES.has(foreign.tool)) {
    const innerTool = foreign.args.tool;
    const innerArgs = foreign.args.args;
    if (typeof innerTool !== 'string' || !knownTools.includes(innerTool)) return null;
    if (!innerArgs || typeof innerArgs !== 'object' || Array.isArray(innerArgs)) return null;
    return {
      call: { tool: innerTool, args: innerArgs as Record<string, any>, raw: '' },
      format: foreign.format,
    };
  }

  if (!knownTools.includes(foreign.tool)) return null;
  return {
    call: { tool: foreign.tool, args: foreign.args as Record<string, any>, raw: '' },
    format: foreign.format,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return null;
}

function hasValidFencedForgeAction(raw: string): boolean {
  FENCED_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCED_BLOCK_RE.exec(raw)) !== null) {
    if (parseToolJsonObject(m[1].trim())) return true;
  }
  return false;
}

/** Scans for the first `{...}` whose top level has a "name" key (OpenAI-style tool_calls body). */
function findBalancedJsonWithName(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = findMatchingBrace(text, i);
    if (end === -1) continue;
    const candidate = text.slice(i, end + 1);
    if (/"name"\s*:\s*"[^"]+"/.test(candidate) && /"(?:arguments|args)"\s*:/.test(candidate)) return candidate;
  }
  return null;
}

function normalizeForeignToolName(name: string): string {
  return name.startsWith('functions.') ? name.slice('functions.'.length) : name;
}

function foreignFromHarmonyPayload(tool: string, payload: string): ForeignToolCall {
  const args = parseJsonObject(payload.trim());
  return { tool: normalizeForeignToolName(tool), args, format: 'harmony-commentary' };
}

/** Harmony `to=<tool>` on any channel; also bare/stripped `to=tool code{...}` shapes. */
function tryDetectHarmonyForeign(text: string): ForeignToolCall | null {
  const harmonyRe =
    /<\|channel\|>\w+\s+to=(?:functions\.)?([\w.-]+)\b[^<]*(?:<\|constrain\|>[^<]*)?<\|message\|>([\s\S]*?)(?:<\|end\|>|(?=<\|start\|>)|$)/gi;
  const harmony = harmonyRe.exec(text);
  if (harmony) return foreignFromHarmonyPayload(harmony[1], harmony[2]);

  const bareRe = /\bto=(?:functions\.)?([\w.-]+)\b(?:\s+(?:json|code))?\s*(\{)/i;
  const bare = bareRe.exec(text);
  if (bare) {
    const braceStart = bare.index + bare[0].length - 1;
    const end = findMatchingBrace(text, braceStart);
    if (end === -1) {
      return { tool: normalizeForeignToolName(bare[1]), args: null, format: 'harmony-commentary' };
    }
    const payload = text.slice(braceStart, end + 1);
    return foreignFromHarmonyPayload(bare[1], payload);
  }
  return null;
}

function textsForHarmonyForeignDetection(raw: string): string[] {
  const out = [raw];
  const stripped = stripHarmonyControlTokens(raw);
  if (stripped && stripped !== raw.trim()) out.push(stripped);
  const garbled = stripped.replace(/^assistant\w*\s*/i, '').trim();
  if (garbled && garbled !== stripped) out.push(garbled);
  return out;
}

/**
 * Detects a tool invocation in a non-Forge format when there is no valid fenced forge_action.
 * Generic (Harmony, XML tool_call, OpenAI-style name/arguments, bare tool/args JSON).
 */
export function detectForeignToolCall(raw: string): ForeignToolCall | null {
  if (hasValidFencedForgeAction(raw)) return null;

  for (const text of textsForHarmonyForeignDetection(raw)) {
    const harmony = tryDetectHarmonyForeign(text);
    if (harmony) return harmony;
  }

  const xmlRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i;
  const xml = xmlRe.exec(raw);
  if (xml) {
    const obj = parseJsonObject(xml[1]);
    if (obj && typeof obj.name === 'string') {
      const args =
        obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
          ? (obj.arguments as Record<string, unknown>)
          : obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
            ? (obj.args as Record<string, unknown>)
            : null;
      return { tool: obj.name, args, format: 'xml-tool-call' };
    }
  }

  const bareName = findBalancedJsonWithName(raw);
  if (bareName) {
    try {
      const obj = JSON.parse(bareName) as { name?: string; arguments?: unknown; args?: unknown };
      if (typeof obj.name === 'string' && (obj.arguments !== undefined || obj.args !== undefined)) {
        const args =
          obj.arguments && typeof obj.arguments === 'object' && !Array.isArray(obj.arguments)
            ? (obj.arguments as Record<string, unknown>)
            : obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
              ? (obj.args as Record<string, unknown>)
              : null;
        return { tool: obj.name, args, format: 'openai-name-arguments' };
      }
    } catch {
      /* ignore */
    }
  }

  const bareTool = findBalancedJsonWithTool(raw);
  if (bareTool) {
    try {
      const obj = JSON.parse(bareTool) as { tool?: unknown; args?: unknown };
      if (typeof obj.tool === 'string' && obj.args !== undefined) {
        if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) {
          return { tool: obj.tool, args: null, format: 'bare-tool-json' };
        }
        return { tool: obj.tool, args: obj.args as Record<string, unknown>, format: 'bare-tool-json' };
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

const FORGE_ACTION_WRAPPER_RESEND =
  ' Resend as ```forge_action\n{"tool":"<tool name>","args":{...}}\n```';

function extractForeignForgeActionPayload(raw: string): string | null {
  const harmonyRe =
    /<\|channel\|>commentary\s+to=(?:functions\.)?forge_action\b[^<]*(?:<\|constrain\|>[^<]*)?<\|message\|>([\s\S]*?)(?:<\|end\|>|(?=<\|start\|>)|$)/i;
  const harmony = harmonyRe.exec(raw);
  if (harmony) return harmony[1].trim();

  const bareRe = /to=(?:functions\.)?forge_action\b\s*(?:json)?\s*(\{[\s\S]*\})/i;
  const bare = bareRe.exec(raw);
  if (bare) return bare[1].trim();

  return null;
}

/** User nudge when the model used a native tool-call format instead of forge_action. */
export function formatForeignToolCallNudge(
  foreign: ForeignToolCall,
  knownTools: string[],
  raw = ''
): string {
  if (FORGE_ACTION_WRAPPER_NAMES.has(foreign.tool)) {
    if (foreign.args === null) {
      const payload = extractForeignForgeActionPayload(raw) ?? '';
      const err = forgeActionJsonParseErrorDetail(payload);
      return `[System check] Not executed: your forge_action call is not valid JSON: ${err.message}, near: ${err.near}.${FORGE_ACTION_WRAPPER_RESEND}`;
    }

    const innerTool = foreign.args.tool;
    const innerArgs = foreign.args.args;
    const hasTool = typeof innerTool === 'string';
    const hasArgs =
      innerArgs !== undefined &&
      typeof innerArgs === 'object' &&
      innerArgs !== null &&
      !Array.isArray(innerArgs);

    if (!hasTool || !hasArgs) {
      let detail: string;
      if (Object.keys(foreign.args).length === 0) detail = 'empty JSON {}';
      else if (!hasTool) detail = 'no "tool" field';
      else detail = 'no "args" object';
      return `[System check] Not executed: your forge_action call had ${detail}.${FORGE_ACTION_WRAPPER_RESEND}`;
    }

    if (!knownTools.includes(innerTool)) {
      return `[System check] Not executed: your forge_action call used unknown tool "${innerTool}". Available tools: ${knownTools.join(', ')}. Resend using a \`\`\`forge_action block with a known tool name.`;
    }
  }

  const known = knownTools.includes(foreign.tool);
  if (!known) {
    const pathHint =
      foreign.args && typeof foreign.args === 'object' && 'path' in foreign.args
        ? ' To read a file use read_file with {"path": ...}; to change one use write_file.'
        : '';
    return `[System check] Not executed: you called ${foreign.tool} using a native tool-call format, which is not a Forge tool. Forge only runs actions written as a \`\`\`forge_action block. Available tools: ${knownTools.join(', ')}. Resend using a \`\`\`forge_action block with a known tool name.${pathHint}`;
  }
  const forgeArgs = foreign.args !== null ? JSON.stringify(foreign.args) : '{}';
  return `[System check] Not executed: you called ${foreign.tool} using a native tool-call format. Forge only runs actions written as a \`\`\`forge_action block. Resend exactly this:\n\`\`\`forge_action\n{"tool":"${foreign.tool}","args":${forgeArgs}}\n\`\`\``;
}

export function formatForeignToolCallCapFailure(foreign: ForeignToolCall, attempts: number): string {
  return `stopped: could not resend ${foreign.tool} as a forge_action block after ${attempts} attempts`;
}

/**
 * Text stored on assistant turns in the model-facing transcript. mlx_lm.server (gpt-oss / Harmony) rejects
 * `<|...|>` control tokens in `content` on replay — analysis is dropped; foreign native tool calls become a short plain line.
 */
export function assistantContentForHistory(raw: string): string {
  const foreign = detectForeignToolCall(raw);
  if (foreign) {
    const argsStr = foreign.args !== null ? JSON.stringify(foreign.args) : '{}';
    return `(called ${foreign.tool} with ${argsStr} in native format)`;
  }

  if (!containsHarmonyControls(raw)) {
    return raw;
  }

  const pre = preprocessHarmonyReply(raw);
  if (pre.displayText) {
    return pre.displayText;
  }

  let stripped = raw.replace(/<\|channel\|>analysis<\|message\|>[\s\S]*?<\|end\|>/gi, '');
  stripped = stripped.replace(/<\|[^|]+\|>/g, '').trim();
  return stripped;
}
