import { ToolSpec } from '../agent/types';
import { readFileTool, listDirTool, writeFileTool, getProblemsTool } from './fileTools';
import { searchCodeTool, searchCodebaseTool } from './searchTools';
import { runCommandTool } from './commandTool';
import { rememberTool, searchChatHistoryTool } from './memoryTools';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    describe: 'Read a text file (optionally a line range) from the workspace.',
    exampleArgs: { path: 'src/index.ts', start_line: 1, end_line: 200 },
    run: readFileTool,
  },
  {
    name: 'list_dir',
    describe: 'List files/folders under a workspace directory (depth up to 4).',
    exampleArgs: { path: 'src', depth: 2 },
    run: listDirTool,
  },
  {
    name: 'search_code',
    describe: 'Literal or /regex/ search across workspace text files. Fast, exact.',
    exampleArgs: { query: 'function loadConfig' },
    run: searchCodeTool,
  },
  {
    name: 'search_codebase',
    describe: 'Semantic search over the indexed workspace for a natural-language question (falls back to keyword search if no embedding model is available).',
    exampleArgs: { query: 'where do we handle user authentication' },
    run: searchCodebaseTool,
  },
  {
    name: 'write_file',
    describe:
      'Propose a file change. Either {"path","content"} to create/fully rewrite a file, or {"path","search","replace"} to replace one exact, unique snippet in an existing file (preferred for small edits — cheaper and safer than a full rewrite). Add {"delete": true} to delete a file. Changes are staged for the user\'s review, not written immediately.',
    exampleArgs: { path: 'src/utils.ts', search: 'function old() {}', replace: 'function old() {\n  return 1;\n}' },
    run: writeFileTool,
  },
  {
    name: 'run_command',
    describe: 'Run a shell command in the workspace root (or a given relative cwd). Requires user approval unless it matches an auto-approve pattern.',
    exampleArgs: { command: 'npm test' },
    run: runCommandTool,
  },
  {
    name: 'get_problems',
    describe: 'Get current editor diagnostics (errors/warnings) for a file, or the whole workspace if no path is given. Useful right after an edit to self-check.',
    exampleArgs: { path: 'src/index.ts' },
    run: getProblemsTool,
  },
  {
    name: 'remember',
    describe:
      'Save a durable fact/preference about this project to .forge/memory.md — injected into every future system prompt so it survives context compaction and new chats. Use for things worth never forgetting (conventions, decisions, credentials locations, user preferences), not routine progress notes.',
    exampleArgs: { fact: 'This repo uses pnpm, not npm.' },
    run: rememberTool,
  },
  {
    name: 'search_chat_history',
    describe:
      'Semantic search over every past chat session in this workspace (not just this conversation) for a natural-language question. Use this instead of asking the user to repeat themselves when something was likely discussed or decided in an earlier chat.',
    exampleArgs: { query: 'why did we switch away from the old auth flow' },
    run: searchChatHistoryTool,
  },
];

export const TOOL_MAP: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((t) => [t.name, t]));
