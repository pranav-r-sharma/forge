import { ToolName } from './types';

export type ForgeMode = 'agent' | 'ask' | 'plan' | 'auto' | 'outcome';

export interface ModeDef {
  id: ForgeMode;
  label: string;
  description: string;
  /** Tools the model is allowed to call in this mode. Empty array = no tools at all (plan mode). */
  allowedTools: ToolName[] | 'all';
  /** Extra instructions appended to the system prompt for this mode. */
  promptFragment: string;
}

const ALL_TOOLS: ToolName[] = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'write_file',
  'run_command',
  'get_problems',
  'remember',
  'search_chat_history',
  'spawn_subagent',
  'web_search',
  'web_fetch',
];

// remember/search_chat_history/web_search/web_fetch are allowed even in
// read-only Ask mode: none of them touch user code or run commands.
// remember only ever writes .forge/memory.md; search_chat_history is pure
// local read-only search; web_search/web_fetch are read-only information
// gathering (their own opt-in gate — forge.webSearch.enabled, see
// websearch/types.ts — is a separate concern from mode-based tool
// availability, and is enforced at the tool-execution layer regardless of
// which mode called them).
const READ_ONLY_TOOLS: ToolName[] = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'get_problems',
  'remember',
  'search_chat_history',
  'web_search',
  'web_fetch',
];

export const MODES: Record<ForgeMode, ModeDef> = {
  agent: {
    id: 'agent',
    label: 'Agent',
    description: 'Full autonomy: reads, edits, and runs commands, iterating until the task is done.',
    allowedTools: 'all',
    promptFragment:
      'You are in AGENT mode: you have full access to every tool, including write_file and run_command. Work autonomously across multiple tool calls until the task is actually complete.',
  },
  auto: {
    id: 'auto',
    label: 'Auto',
    description: 'Fully autonomous — no approvals for edits or commands. Keeps working through failures on its own. A checkpoint is saved before every turn so you can always revert.',
    allowedTools: 'all',
    promptFragment:
      'You are in AUTO mode: fully autonomous. Every file edit and shell command is applied immediately WITHOUT asking the user for approval — there is no human reviewing each step as you go, only reviewing the end result (and they can revert to a checkpoint saved before this turn if something goes wrong, so acting is safe). Because of this: 1) Be more careful, not less — think before large or destructive changes, and prefer additive/reversible steps. 2) If a tool call fails or a command errors, do NOT stop and ask — diagnose the failure from its output and try a different approach; only stop and produce a final answer once the task is genuinely done, genuinely impossible, or you are repeating the same failing approach with no new information (in which case explain what you tried and why it isn\'t working, rather than looping forever — Forge will also automatically detect and halt repetitive loops). 3) Still never fabricate that you\'ve done something — only report an action as done after its tool result actually confirms it.',
  },
  outcome: {
    id: 'outcome',
    label: 'Outcome',
    description: 'State the destination, not the steps — Forge works backward from it and keeps iterating, checking its own progress, until it\'s reached.',
    allowedTools: 'all',
    promptFragment:
      'You are in OUTCOME mode ("reverse engineering"): the user\'s message is a GOAL — a description of a desired end state — not a to-do list, and quite possibly not something they know how to get to themselves. Your job is to work BACKWARD from that goal: 1) First, restate the goal to yourself as concrete, checkable criteria — what would you (or a command, or a test) be able to observe if this goal were actually met? If the goal is vague, make a reasonable concrete interpretation rather than stopping to ask — you are working autonomously. 2) Investigate the current state (read files, run diagnostics) and identify the specific gap between where things are now and those criteria — this is the actual plan: close that gap, not "do generic related work." 3) Like AUTO mode, every edit and command applies immediately with NO approval prompt (except the hard-coded dangerous-command denylist) — a checkpoint before this turn means it\'s safe to revert if this goes wrong. If a step fails, diagnose and try a different approach rather than stopping to ask. 4) Do NOT declare the goal met just because you believe your changes should work — if a "definition of done" check command is configured, Forge will automatically run it after your final answer and hand you the result if it fails, so an unearned "done" claim will just bounce back with real evidence; treat that as expected and keep iterating rather than repeating the same claim. If no check command is configured, you must find your own way to verify (re-read the file, run a relevant command, re-run tests) before calling it done — never conclude success from intent alone. 5) Only stop and explain instead of continuing if the goal is genuinely ambiguous in a way no reasonable interpretation resolves, is impossible given what you can observe, or you are repeating the same failing approach with no new information (Forge\'s loop detector will also catch that).',
  },
  ask: {
    id: 'ask',
    label: 'Ask',
    description: 'Read-only Q&A over the codebase — no edits, no commands.',
    allowedTools: READ_ONLY_TOOLS,
    promptFragment:
      'You are in ASK mode: read-only. You may use read_file, list_dir, search_code, search_codebase, and get_problems to investigate, but write_file and run_command are NOT available to you in this mode — do not attempt them. Answer the question directly; if the user actually wants you to make a change, tell them to switch to Agent mode.',
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Drafts a step-by-step plan for you to review before anything runs.',
    allowedTools: [],
    promptFragment:
      'You are in PLAN mode: you have NO tools available at all in this turn, so do not emit a forge_action block under any circumstances — always reply in plain text. Investigate only from context already given to you (attached files, prior messages) and produce a concise, numbered, step-by-step implementation plan for the request: what files you expect to touch, what you\'ll change in each, and any commands you\'d expect to run, in the order you\'d do them. Do not write actual code changes yet. End with a one-line summary of the intended outcome. The user will review this plan and, if they approve it, a follow-up turn in Agent mode will execute it.',
  },
};

export function toolsAllowedInMode(mode: ForgeMode): ToolName[] {
  const def = MODES[mode];
  return def.allowedTools === 'all' ? ALL_TOOLS : def.allowedTools;
}

/** Whether a mode takes autonomous action at all, and so can meaningfully use a "definition of done" verify command (see ChatSession.verifyCommand / agentLoop's verify-gated final-answer loop). Ask/Plan never touch anything, so a done-check has nothing to check. */
export function modeSupportsVerifyCommand(mode: ForgeMode): boolean {
  return mode === 'agent' || mode === 'auto' || mode === 'outcome';
}

/**
 * Whether a mode is fully autonomous: no approval prompts for writes or
 * commands, and the generous auto-mode iteration cap. Auto and Outcome are
 * deliberately kept as distinct modes (different system prompts, labels, and
 * UI) — Outcome additionally frames the message as a goal to work backward
 * from — but they share this exact same no-approval, keep-going behavior.
 * Both `agentLoop.ts` and `chatSession.ts`'s ApprovalBroker wiring must gate
 * on this helper rather than `mode === 'auto'` directly, or a mode added
 * here with autonomous behavior will silently still require approvals (this
 * is exactly the bug that shipped in Outcome mode through 0.6.0).
 */
export function isAutonomousMode(mode: ForgeMode): boolean {
  return mode === 'auto' || mode === 'outcome';
}
