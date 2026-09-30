import { ToolSpec } from '../agent/types';
import { readFileTool, listDirTool, writeFileTool, getProblemsTool } from './fileTools';
import { searchCodeTool, searchCodebaseTool } from './searchTools';
import { runCommandTool } from './commandTool';
import { checkBackgroundCommandTool } from './backgroundCommandTool';
import { rememberTool, searchChatHistoryTool } from './memoryTools';
import { spawnSubAgentTool } from './subAgentTool';
import { planTasksTool, updateTaskTool } from './taskLedgerTools';
import { webFetchTool, webSearchTool } from './webTools';

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
      'Propose a file change. Either {"path","content"} to create/fully rewrite a file, or {"path","search","replace"} to replace one exact, unique snippet in an existing file (preferred for small edits — cheaper and safer than a full rewrite). For large new files (over ~300 lines), write the first part with {"path","content"}, then add the rest in further calls with {"path","content","append":true} (each chunk must fit in one reply). To change SEVERAL places in one file use ONE call: {"path","edits":[{"search","replace"},…]} (applied in order, all-or-nothing). To replace EVERY occurrence of a string in a file (e.g. renaming a symbol) add {"all": true} to a search/replace. Add {"delete": true} to delete a file. Changes are staged for the user\'s review, not written immediately.',
    exampleArgs: { path: 'src/utils.ts', search: 'function old() {}', replace: 'function old() {\n  return 1;\n}' },
    run: writeFileTool,
  },
  {
    name: 'run_command',
    describe:
      'Run a shell command in the workspace root (or a given relative cwd). Requires user approval unless it matches an auto-approve pattern. Waits for the command to exit (up to a ~3min timeout) and returns its output — for anything that\'s SUPPOSED to keep running instead (a dev server, a watcher), add {"background": true} and use check_background_command to follow up instead of letting it hit the timeout.',
    exampleArgs: { command: 'npm test' },
    run: runCommandTool,
  },
  {
    name: 'check_background_command',
    describe:
      'Check output/status of a command started with run_command\'s {"background": true}, or kill/list them. {"id"} (or {"id","action":"status"}) for output so far, {"id","action":"kill"} to stop it, {"action":"list"} to see every background command\'s id if you\'ve lost track.',
    exampleArgs: { id: 'bg_abc123_1' },
    run: checkBackgroundCommandTool,
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
  {
    name: 'spawn_subagent',
    describe:
      'Delegate a self-contained sub-task to a nested, fully autonomous sub-agent (its own bounded tool-call loop, no approvals) and get back a summary of what it did/found. Sub-agent turns run in auto mode with an empty message history (only your task/context), forge.requirements extract disabled, but the same workspace memory/project log as this chat. Use this to parallelize-in-spirit a task that splits cleanly into independent pieces (e.g. "investigate why build fails" + "investigate why tests fail" as two separate sub-agents), or to delegate a well-scoped chunk of work without cluttering your own tool-call history with its step-by-step trace. Give it a specific, self-contained task description — it does not see this conversation, only what you put in "task"/"context". Nesting is capped (a sub-agent cannot itself spawn more than one further level of sub-agents). If you are picking this session back up and see a "[~]" (in-progress) or "[!]" (failed) task in the task ledger below — one that was already being worked on before an interruption — pass its ledger id as "resumeTaskId" instead of describing it as a brand new task: the sub-agent will be told what was already found/attempted so it can pick up from there rather than re-investigating from zero.',
    exampleArgs: { task: 'Find and fix the TypeScript error in src/utils/date.ts', context: 'The error is "Property \'toISO\' does not exist". Likely a typo for toISOString.' },
    run: spawnSubAgentTool,
  },
  {
    name: 'plan_tasks',
    describe:
      'Mandatory checkpoint-progress framework (item "checkpoint progress so an interrupted agent picks up where it left off, not redundant work"): record one or more tasks as pending entries in this chat\'s task ledger, optionally as children of an existing task id (for breaking one task into sub-steps). Use this near the start of any multi-step or multi-part piece of work — especially before spawning sub-agents (though each spawn_subagent call also auto-records its own ledger entry regardless) — so the ledger reflects your actual plan and a resumed session can see what\'s already done vs. still pending instead of re-deriving it from scratch. Each entry in "tasks" can be a bare description string, or (recommended, cost-aware planning) an object {"description", "costTier", "costNote"}: set "costTier" to "cheap" (a single file read or small localized edit), "moderate" (a few files or a moderately sized change), or "expensive" (a large refactor, many files, a migration — anything likely to take a long chain of tool calls) based on what you actually know about the task and codebase; "costNote" is an optional one-line reason. If you omit costTier, Forge estimates one from the description text as a fallback, but your own judgment is almost always better. A plan whose total estimated cost is high gets flagged to the user automatically — you don\'t need to ask about this yourself, just estimate honestly.',
    exampleArgs: {
      tasks: [
        { description: 'Investigate why the build is failing', costTier: 'moderate' },
        { description: 'Investigate why the tests are failing', costTier: 'moderate' },
        { description: 'Refactor the shared config loader once the root cause is clear', costTier: 'expensive', costNote: 'touches every module that imports it' },
      ],
    },
    run: planTasksTool,
  },
  {
    name: 'update_task',
    describe:
      'Marks a task ledger entry (created by plan_tasks, or the id spawn_subagent\'s result mentions) as "in_progress", "done", or "failed", with an optional short outcome summary. Call this yourself for any ledger task you work on directly (spawn_subagent already updates its own entry automatically) — a task left "pending"/"in_progress" forever is exactly the redundant-work-after-interruption problem this framework exists to prevent.',
    exampleArgs: { id: 'task_abc123_1', status: 'done', summary: 'Build was failing due to a stale lockfile; regenerated it and the build passes now.' },
    run: updateTaskTool,
  },
  {
    name: 'web_search',
    describe:
      'Search the public internet for a natural-language query and get back titles/URLs/snippets. Only available when the user has enabled forge.webSearch.enabled (off by default — this is the one Forge tool that sends data outside your machine). Use for anything the codebase itself can\'t answer: current library/API docs, error messages, versions/release notes, general knowledge, current events. Follow up with web_fetch on a promising URL when a snippet isn\'t enough detail.',
    exampleArgs: { query: 'ollama num_ctx default context window size' },
    run: webSearchTool,
  },
  {
    name: 'web_fetch',
    describe:
      'Fetch a specific URL (e.g. one returned by web_search) and get back its extracted readable text, paged by character offset for long pages. Respects robots.txt by default. Cannot read PDFs or other binary files — HTML/text/JSON only.',
    exampleArgs: { url: 'https://example.com/docs/page', offset: 0 },
    run: webFetchTool,
  },
];

export const TOOL_MAP: Record<string, ToolSpec> = Object.fromEntries(TOOL_SPECS.map((t) => [t.name, t]));
