import { ChatMessage } from '../ollama/types';
import { extractTaskCommandForms, commandMatchesTaskForm, parseRunCommandExitCode, normalizeCommandWhitespace } from './claimChecker';

export type RequirementStatus = 'open' | 'done' | 'unverified' | 'declined';

export type RequirementKind = 'checkable' | 'judgment';

export interface RequirementItem {
  id: number;
  text: string;
  kind: RequirementKind;
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

const VAGUE_ONLY_RE =
  /^(?:keep|use|handle|ensure|make|write|add|fix|avoid)\s+(?:the\s+)?(?:code|functions?|things?|it|input|output|state)\b/i;

const CHECKLIST_HEADER = '## Requirements (track each)';
const CHECKLIST_FORMAT_HINT =
  'For `[?]` items, address each in a final **Requirements:** section (`N. done — …` or `N. not done — …`). `[ ]` items need tool evidence (edit or successful command) in this session.';

function dedupeKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function wordsOf(key: string): Set<string> {
  return new Set(key.split(/\W+/).filter((w) => w.length > 2));
}

function primaryPathInText(text: string): string | null {
  const m = /[\w@./-]+\.py\b/i.exec(text);
  return m ? m[0].toLowerCase() : null;
}

function isNearDuplicateOfExisting(text: string, items: RequirementItem[]): boolean {
  const key = dedupeKey(text);
  const path = primaryPathInText(text);
  const pathScoped =
    path &&
    (/Create or update file/i.test(text) ||
      /^[`'"]?[\w@./-]+\.py\b/i.test(text.trim()) ||
      /^-\s+`/.test(text.trim()));
  for (const it of items) {
    const other = dedupeKey(it.text);
    if (
      pathScoped &&
      ( /Create or update file/i.test(it.text) ||
        /^[`'"]?[\w@./-]+\.py\b/i.test(it.text.trim()) ||
        /^-\s+`/.test(it.text.trim())) &&
      primaryPathInText(it.text) === path
    ) {
      return true;
    }
    if (key === other) return true;
    if (key.length > 20 && other.length > 20 && (key.includes(other) || other.includes(key))) return true;
    const a = wordsOf(key);
    const b = wordsOf(other);
    if (a.size < 3 || b.size < 3) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    if (union > 0 && inter / union >= 0.82) return true;
  }
  return false;
}

function pathMentionedInText(text: string, path: string): boolean {
  const norm = path.replace(/^\.\//, '');
  const low = text.toLowerCase();
  return low.includes(path.toLowerCase()) || low.includes(norm.toLowerCase());
}

/** Checkable = file/command/compile evidence from the transcript; judgment = self-report or holistic. */
export function classifyRequirementKind(text: string): RequirementKind {
  if (/Run command form:/i.test(text)) return 'checkable';
  if (/Create or update file/i.test(text)) return 'checkable';
  if (/\bpy_compile\b/i.test(text)) return 'checkable';
  if (/\bpython3\s+main\.py\b/i.test(text)) return 'checkable';
  if (/\bpython3\s+-m\b/i.test(text) && /\.py\b/i.test(text)) return 'checkable';
  const backtick = /`([^`]+)`/.exec(text)?.[1];
  if (backtick) {
    if (/\.(py|ts|tsx|js|sh)\b/i.test(backtick) || /\bpython3\b/i.test(backtick)) return 'checkable';
    if (extractTaskCommandForms(backtick).length > 0) return 'checkable';
  }
  if (FILE_PATH_RE.test(text)) {
    FILE_PATH_RE.lastIndex = 0;
    return 'checkable';
  }
  if (extractTaskCommandForms(text).length > 0) return 'checkable';
  return 'judgment';
}

function pushItem(items: RequirementItem[], text: string, seen: Set<string>): void {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < 10 || t.length > 400) return;
  if (VAGUE_ONLY_RE.test(t) && !/\.(py|ts|js)\b/i.test(t) && !/`/.test(t)) return;
  const key = dedupeKey(t);
  if (seen.has(key)) return;
  if (isNearDuplicateOfExisting(t, items)) return;
  seen.add(key);
  items.push({ id: items.length + 1, text: t, kind: classifyRequirementKind(t), status: 'open' });
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
    if (trimmed.length < 16) continue;
    if (!REQUIREMENT_CUE_RE.test(trimmed) && !REQUIRED_OUTPUT_RE.test(trimmed)) continue;
    if (isNearDuplicateOfExisting(trimmed, items)) continue;
    pushItem(items, trimmed, seen);
  }

  let pathMatch: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while (allowCueHeuristics && items.length < maxItems && (pathMatch = FILE_PATH_RE.exec(userMessage))) {
    const path = pathMatch[1];
    if (items.some((it) => pathMentionedInText(it.text, path))) continue;
    pushItem(items, `Create or update file \`${path}\` as specified.`, seen);
  }

  for (const form of extractTaskCommandForms(userMessage)) {
    if (items.length >= maxItems) break;
    const label = `Run command form: \`${form}\`.`;
    if (items.some((it) => it.text.includes(form))) continue;
    pushItem(items, label, seen);
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

export interface RequirementSelfReportLine {
  id: number;
  verdict: 'done' | 'not_done';
  note: string;
}

/** Parse a model "Requirements:" block (tolerant). */
export function parseRequirementsSelfReport(content: string): RequirementSelfReportLine[] {
  const section = /(?:^|\n)\s*requirements\s*:?\s*\n([\s\S]*)/im.exec(content);
  if (!section) return [];
  const lines: RequirementSelfReportLine[] = [];
  const lineRe =
    /^\s*(\d+)\.\s*(done|not\s+done|met|unmet|open|waived|skipped)\s*(?:[—–\-:]+\s*|\s+-\s+)(.+)\s*$/i;
  for (const raw of section[1].split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || !/^\d+\./.test(trimmed)) {
      if (lines.length > 0 && trimmed && !/^\d+\./.test(trimmed)) break;
      continue;
    }
    const m = lineRe.exec(trimmed);
    if (!m) continue;
    const verdictRaw = m[2].toLowerCase().replace(/\s+/g, '_');
    const verdict: 'done' | 'not_done' =
      verdictRaw === 'not_done' || verdictRaw === 'unmet' || verdictRaw === 'open' ? 'not_done' : 'done';
    lines.push({ id: parseInt(m[1], 10), verdict, note: m[3].trim() });
  }
  return lines;
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
  return pathMentionedInText(itemText, path);
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

function applySelfReports(items: RequirementItem[], messages: ChatMessage[]): RequirementItem[] {
  const byId = new Map<number, RequirementSelfReportLine>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const line of parseRequirementsSelfReport(m.content)) {
      byId.set(line.id, line);
    }
  }
  return items.map((item) => {
    if (item.kind !== 'judgment') return item;
    const report = byId.get(item.id);
    if (!report) return item;
    if (report.verdict === 'done') {
      return { ...item, status: 'done' as const, evidence: `self-report: ${report.note.slice(0, 120)}` };
    }
    return { ...item, status: 'declined' as const, evidence: `not done: ${report.note.slice(0, 120)}` };
  });
}

/** Update checklist status from the full transcript (deterministic). */
export function updateRequirementsFromMessages(state: RequirementsState, messages: ChatMessage[]): RequirementsState {
  const { writtenPaths, okCommands } = scanTranscriptFacts(messages);
  let items = state.items.map((item) => {
    if (item.status === 'done' || item.status === 'declined') return item;
    for (const path of writtenPaths) {
      if (item.kind === 'checkable' && pathMentionedInItem(item.text, path)) {
        return { ...item, status: 'done' as const, evidence: `write_file ${path}` };
      }
    }
    for (const cmd of okCommands) {
      const formInItem = /`([^`]+)`/.exec(item.text)?.[1];
      const formMatch = formInItem ? commandMatchesTaskForm(formInItem, cmd) : false;
      if (
        item.kind === 'checkable' &&
        (commandMentionedInItem(item.text, cmd) || formMatch)
      ) {
        return { ...item, status: 'done' as const, evidence: `run_command ok: ${normalizeCommandWhitespace(cmd).slice(0, 80)}` };
      }
    }
    if (
      item.kind === 'checkable' &&
      /\bcompile\b/i.test(item.text) &&
      okCommands.some((c) => /py_compile|tsc|compile/i.test(c))
    ) {
      return { ...item, status: 'unverified' as const, evidence: 'compile-related command ran' };
    }
    return item;
  });
  items = applySelfReports(items, messages);
  return { ...state, items };
}

function markForPrompt(it: RequirementItem): string {
  if (it.status === 'done') return '[x]';
  if (it.status === 'declined') return '[!]';
  if (it.status === 'unverified') return '[~]';
  return it.kind === 'judgment' ? '[?]' : '[ ]';
}

export function renderRequirementsChecklistForPrompt(state: RequirementsState): string {
  if (state.items.length === 0) return '';
  const lines = state.items.map((it) => {
    const mark = markForPrompt(it);
    const ev = it.evidence ? ` — ${it.evidence}` : '';
    return `${mark} ${it.id}. ${it.text}${ev}`;
  });
  return `${CHECKLIST_HEADER}\n${lines.join('\n')}\n\n${CHECKLIST_FORMAT_HINT}`;
}

/** Items still open or unverified without evidence — block premature "done". */
export function findRequirementsGateGaps(state: RequirementsState): RequirementItem[] {
  return state.items.filter((it) => {
    if (it.status === 'done' || it.status === 'declined') return false;
    if (it.status === 'unverified' && it.evidence) return false;
    if (it.kind === 'judgment') return it.status === 'open';
    return it.status === 'open' || (it.status === 'unverified' && !it.evidence);
  });
}

export function formatRequirementsGateNudge(missing: RequirementItem[]): string {
  const list = missing
    .slice(0, 12)
    .map((it) => `${it.id}. ${it.text}${it.kind === 'judgment' ? ' (judgment — report in Requirements:)' : ' (needs tool evidence)'}`)
    .join('\n');
  return `[System check] These requirements are still open:\n${list}\n\nBefore finishing, either satisfy each checkable item with a tool call, or include a **Requirements:** section in your reply:\n\nRequirements:\n1. done — <how you satisfied it>\n2. not done — <honest reason>\n\nUse the checklist item numbers. A honest "not done — reason" is accepted for judgment items.`;
}

export function requirementGateMarkers(missing: RequirementItem[]): string[] {
  return missing.map((it) => `requirement open: ${it.id} ${it.text.slice(0, 120)}`);
}

export function estimateChecklistPromptChars(state: RequirementsState): number {
  return renderRequirementsChecklistForPrompt(state).length;
}

const REQUIREMENTS_HEADER = CHECKLIST_HEADER;

/** Remove a prior checklist injection so only the current tail carries it (prefix-stable across steps). */
export function stripRequirementsBlockFromContent(content: string): string {
  const idx = content.indexOf(REQUIREMENTS_HEADER);
  if (idx < 0) return content;
  let end = content.length;
  const after = content.slice(idx);
  const hintIdx = after.indexOf(CHECKLIST_FORMAT_HINT);
  if (hintIdx >= 0) end = idx + hintIdx + CHECKLIST_FORMAT_HINT.length;
  return content.slice(0, end).replace(/\n+$/, '');
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

/** Declined judgment items for surfacing in the final user-visible note. */
export function declinedRequirementNotes(state: RequirementsState): string[] {
  return state.items
    .filter((it) => it.status === 'declined' && it.evidence)
    .map((it) => `${it.id}. ${it.text} — ${it.evidence}`);
}
