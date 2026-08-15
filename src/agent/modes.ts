import { ToolName } from './types';

export type ForgeMode = 'agent' | 'ask' | 'plan';

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
];

const READ_ONLY_TOOLS: ToolName[] = ['read_file', 'list_dir', 'search_code', 'search_codebase', 'get_problems'];

export const MODES: Record<ForgeMode, ModeDef> = {
  agent: {
    id: 'agent',
    label: 'Agent',
    description: 'Full autonomy: reads, edits, and runs commands, iterating until the task is done.',
    allowedTools: 'all',
    promptFragment:
      'You are in AGENT mode: you have full access to every tool, including write_file and run_command. Work autonomously across multiple tool calls until the task is actually complete.',
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
