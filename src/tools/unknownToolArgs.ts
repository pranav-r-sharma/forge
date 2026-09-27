import { ToolSpec } from '../agent/types';
import { DynamicToolSpec } from '../mcp/mcpTypes';

/** Every arg name each built-in tool accepts (including common aliases like `file` for `path`). */
export const BUILTIN_TOOL_ARG_NAMES: Record<string, readonly string[]> = {
  read_file: ['path', 'file', 'start_line', 'end_line'],
  list_dir: ['path', 'depth'],
  search_code: ['query', 'pattern', 'glob'],
  search_codebase: ['query', 'k'],
  write_file: ['path', 'file', 'content', 'search', 'replace', 'edits', 'all', 'delete'],
  run_command: ['command', 'cwd', 'background', 'timeout_ms'],
  check_background_command: ['id', 'action'],
  get_problems: ['path', 'file'],
  remember: ['fact', 'text'],
  search_chat_history: ['query', 'k'],
  spawn_subagent: ['task', 'context', 'resumeTaskId'],
  plan_tasks: ['tasks', 'parentTaskId'],
  update_task: ['id', 'status', 'summary'],
  web_search: ['query'],
  web_fetch: ['url', 'offset', 'length'],
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

/** Score how likely `unknown` was meant to be `candidate` (higher = better). */
export function argNameSimilarity(unknown: string, candidate: string): number {
  const a = unknown.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 100;
  const partsA = a.split('_').filter(Boolean);
  const partsB = new Set(b.split('_').filter(Boolean));
  let shared = 0;
  for (const p of partsA) if (partsB.has(p)) shared++;
  if (shared >= 2) return 55 + shared * 8;
  if (shared === 1 && partsA.length <= 3 && partsB.size <= 3) return 42;
  const dist = levenshtein(a, b);
  if (dist <= 2) return 45 - dist * 5;
  if (dist <= 4 && Math.abs(a.length - b.length) <= 2) return 35 - dist;
  return 0;
}

export function suggestClosestArgName(unknown: string, known: readonly string[]): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const k of known) {
    const score = argNameSimilarity(unknown, k);
    if (score >= 40 && (!best || score > best.score)) best = { name: k, score };
  }
  return best?.name;
}

export function knownArgNamesForBuiltIn(toolName: string, spec?: ToolSpec): string[] {
  const fromMap = BUILTIN_TOOL_ARG_NAMES[toolName];
  if (fromMap) return [...fromMap];
  if (spec?.exampleArgs) return Object.keys(spec.exampleArgs);
  return [];
}

export function knownArgNamesForMcp(spec: DynamicToolSpec): string[] {
  const schema = spec.inputSchema;
  if (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
    return Object.keys(schema.properties as Record<string, unknown>);
  }
  return Object.keys(spec.exampleArgs ?? {});
}

/**
 * Lines to prepend to a successful tool result when the model sent arg names
 * this tool does not recognize (call still runs when required args are present).
 */
export function formatUnknownArgNotes(tool: string, args: Record<string, unknown>, known: readonly string[]): string {
  const knownLower = new Set(known.map((k) => k.toLowerCase()));
  const unknownKeys = Object.keys(args).filter((k) => !knownLower.has(k.toLowerCase()));
  if (unknownKeys.length === 0) return '';

  const validList = [...new Set(known)].sort().join(', ');
  const lines: string[] = [];
  for (const key of unknownKeys) {
    const suggestion = suggestClosestArgName(key, known);
    if (suggestion) {
      lines.push(`Note: ${tool} has no arg "${key}" (ignored) — did you mean "${suggestion}"?`);
    } else {
      lines.push(`Note: ${tool} has no arg "${key}" (ignored); valid args: ${validList}.`);
    }
  }
  return lines.join('\n');
}

export function unknownArgNotesForSpec(
  spec: ToolSpec | DynamicToolSpec,
  args: Record<string, unknown>,
): string {
  const known =
    'serverName' in spec ? knownArgNamesForMcp(spec as DynamicToolSpec) : knownArgNamesForBuiltIn(spec.name, spec as ToolSpec);
  return formatUnknownArgNotes(spec.name, args, known);
}
