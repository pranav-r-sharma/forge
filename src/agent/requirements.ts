import { ChatMessage } from '../ollama/types';
import { extractTaskCommandForms, commandMatchesTaskForm, parseRunCommandExitCode, normalizeCommandWhitespace } from './claimChecker';

export type RequirementStatus = 'open' | 'done' | 'unverified';

export interface RequirementItem {
  id: number;
  text: string;
  status: RequirementStatus;
  evidence?: string;
}

export interface RequirementsState {
  items: RequirementItem[];
  sourceChars: number;
}

export const DEFAULT_MAX_REQUIREMENTS = 24;
export const PINNED_USER_MESSAGE_MAX_CHARS = 6000;

const REQUIREMENT_CUE_RE =
  /\b(?:must|should|need to|needs to|make sure|do not|don't|never|always|only|each|every|all)\b/i;

const FILE_PATH_RE =
  /(?:^|[\s`'"(])([\w@./-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|kt|rb|md|json|yaml|yml|sh|toml|css|html|vue|sql))(?:$|[\s`'",.:;])/gi;

const NUMBERED_LINE_RE = /^\s*(?:\d+[.)]\s+|[-*•]\s+)(.+)$/;
const REQUIRED_OUTPUT_RE = /\b(?:prints?|print|outputs?|exit\s+\d+|stderr|stdout|format|exact(?:ly)?)\b/i;

function dedupeKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function pushItem(items: RequirementItem[], text: string, seen: Set<string>): void {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 8 || t.length > 400) return;
  const key = dedupeKey(t);
  if (seen.has(key)) return;
  seen.add(key);
  items.push({ id: items.length + 1, text: t, status: 'open' });
}

/** Deterministic extraction from the user task text (model-agnostic). */
export function extractRequirementsFromUserMessage(
  userMessage: string,
  maxItems: number = DEFAULT_MAX_REQUIREMENTS,
): RequirementsState {
  const items: RequirementItem[] = [];
  const seen = new Set<string>();

  for (const line of userMessage.split('\n')) {
    const numbered = NUMBERED_LINE_RE.exec(line);
    if (numbered) {
      pushItem(items, numbered[1], seen);
      if (items.length >= maxItems) break;
    }
  }

  const allowCueHeuristics = userMessage.length >= 120 || items.length > 0;

  for (const line of userMessage.split(/(?<=[.!?])\s+/)) {
    if (!allowCueHeuristics) break;
    if (items.length >= maxItems) break;
    const trimmed = line.trim();
    if (trimmed.length < 12) continue;
    if (REQUIREMENT_CUE_RE.test(trimmed) || REQUIRED_OUTPUT_RE.test(trimmed)) {
      pushItem(items, trimmed, seen);
    }
  }

  let pathMatch: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while (allowCueHeuristics && items.length < maxItems && (pathMatch = FILE_PATH_RE.exec(userMessage))) {
    const path = pathMatch[1];
    pushItem(items, `Create or update file \`${path}\` as specified.`, seen);
  }

  for (const form of extractTaskCommandForms(userMessage)) {
    if (items.length >= maxItems) break;
    pushItem(items, `Run command form: \`${form}\`.`, seen);
  }

  const finishSection = /\bwhen you are done\b[:\s]*([\s\S]*)/i.exec(userMessage);
  if (finishSection && items.length < maxItems) {
    for (const line of finishSection[1].split('\n')) {
      const numbered = NUMBERED_LINE_RE.exec(line);
      if (numbered) pushItem(items, numbered[1], seen);
      if (items.length >= maxItems) break;
    }
  }

  return { items, sourceChars: userMessage.length };
}

function isToolResultUserMessage(content: string): boolean {
  return (
    content.startsWith('[Tool ') ||
    content.startsWith('[Tool error]') ||
    content.startsWith('[System check]') ||
    content.startsWith('[Definition-of-done') ||
    content.startsWith('[Earlier conversation summary')
  );
}

function pathMentionedInItem(itemText: string, path: string): boolean {
  const norm = path.replace(/^\.\//, '');
  const low = itemText.toLowerCase();
  return low.includes(path.toLowerCase()) || low.includes(norm.toLowerCase());
}

function commandMentionedInItem(itemText: string, command: string): boolean {
  if (itemText.includes('`') && itemText.includes(command.split(/\s+/)[0] ?? '')) {
    const form = extractTaskCommandForms(itemText)[0];
    if (form && commandMatchesTaskForm(form, command)) return true;
  }
  const norm = normalizeCommandWhitespace(command);
  return itemText.toLowerCase().includes(norm.toLowerCase().slice(0, 40));
}

function scanTranscriptFacts(messages: ChatMessage[]): {
  writtenPaths: string[];
  okCommands: string[];
} {
  const writtenPaths: string[] = [];
  const okCommands: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const re = /```forge_action\s*([\s\S]*?)```/gi;
      let block: RegExpExecArray | null;
      while ((block = re.exec(m.content))) {
        try {
          const parsed = JSON.parse(block[1].trim()) as { tool?: string; args?: Record<string, unknown> };
          if (parsed.tool === 'write_file' && typeof parsed.args?.path === 'string') {
            writtenPaths.push(parsed.args.path);
          }
          if (parsed.tool === 'run_command' && typeof parsed.args?.command === 'string') {
            const next = messages[i + 1];
            if (next?.role === 'user' && next.content.includes('[Tool "run_command" result]')) {
              const code = parseRunCommandExitCode(next.content);
              if (code === 0) okCommands.push(parsed.args.command);
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { writtenPaths, okCommands };
}

/** Update checklist status from the full transcript (deterministic). */
export function updateRequirementsFromMessages(state: RequirementsState, messages: ChatMessage[]): RequirementsState {
  const { writtenPaths, okCommands } = scanTranscriptFacts(messages);
  const items = state.items.map((item) => {
    if (item.status === 'done') return item;
    for (const path of writtenPaths) {
      if (pathMentionedInItem(item.text, path)) {
        return { ...item, status: 'done' as const, evidence: `write_file ${path}` };
      }
    }
    for (const cmd of okCommands) {
      const formInItem = /`([^`]+)`/.exec(item.text)?.[1];
      const formMatch = formInItem ? commandMatchesTaskForm(formInItem, cmd) : false;
      if (commandMentionedInItem(item.text, cmd) || formMatch) {
        return { ...item, status: 'done' as const, evidence: `run_command ok: ${normalizeCommandWhitespace(cmd).slice(0, 80)}` };
      }
    }
    if (/\bcompile\b/i.test(item.text) && okCommands.some((c) => /py_compile|tsc|compile/i.test(c))) {
      return { ...item, status: 'unverified' as const, evidence: 'compile-related command ran' };
    }
    return item;
  });
  return { ...state, items };
}

export function renderRequirementsChecklistForPrompt(state: RequirementsState): string {
  if (state.items.length === 0) return '';
  const lines = state.items.map((it) => {
    const mark = it.status === 'done' ? '[x]' : it.status === 'unverified' ? '[~]' : '[ ]';
    const ev = it.evidence ? ` — ${it.evidence}` : '';
    return `${mark} ${it.id}. ${it.text}${ev}`;
  });
  return `## Requirements (track each)\n${lines.join('\n')}`;
}

/** Items still open or unverified without evidence — block premature "done". */
export function findRequirementsGateGaps(state: RequirementsState): RequirementItem[] {
  return state.items.filter((it) => it.status === 'open' || (it.status === 'unverified' && !it.evidence));
}

export function formatRequirementsGateNudge(missing: RequirementItem[]): string {
  const list = missing
    .slice(0, 12)
    .map((it) => `${it.id}. ${it.text}`)
    .join('\n');
  return `[System check] These requirements from the user's request are not yet satisfied (no evidence in this session):\n${list}\n\nAddress each item, or explain clearly in your next reply why it does not apply.`;
}

export function requirementGateMarkers(missing: RequirementItem[]): string[] {
  return missing.map((it) => `requirement open: ${it.id} ${it.text.slice(0, 120)}`);
}

export function estimateChecklistPromptChars(state: RequirementsState): number {
  return renderRequirementsChecklistForPrompt(state).length;
}

const REQUIREMENTS_HEADER = '## Requirements (track each)';

/** Remove a prior checklist injection so only the current tail carries it (prefix-stable across steps). */
export function stripRequirementsBlockFromContent(content: string): string {
  const idx = content.indexOf(REQUIREMENTS_HEADER);
  if (idx < 0) return content;
  return content.slice(0, idx).replace(/\n+$/, '');
}

/**
 * Prepends the live checklist to the last user message in the prompt view only
 * (archival messages unchanged — cache-friendly tail injection).
 */
export function injectRequirementsIntoPromptView(view: ChatMessage[], checklistBlock: string): ChatMessage[] {
  if (!checklistBlock) return view;
  const copy = view.map((m) =>
    m.role === 'user' ? { ...m, content: stripRequirementsBlockFromContent(m.content) } : m,
  );
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === 'user') {
      const c = copy[i].content;
      if (c.startsWith(checklistBlock)) return copy;
      copy[i] = { ...copy[i], content: `${checklistBlock}\n\n${c}` };
      return copy;
    }
  }
  return copy;
}

export function isRealUserTurnContent(content: string): boolean {
  return !isToolResultUserMessage(content) && !content.startsWith('[Attached ');
}

/** Cap pinned follow-up user messages for compaction (proposal 5). */
export function capPinnedUserContent(content: string, maxChars: number = PINNED_USER_MESSAGE_MAX_CHARS): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n... (pinned user message truncated)';
}
