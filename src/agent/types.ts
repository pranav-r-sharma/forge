import * as vscode from 'vscode';
import { OllamaCallMetrics } from '../ollama/types';
import { WebFetchResult, WebSearchResult } from '../websearch/types';

/** Names of every tool the agent may invoke. Kept as a union so callers get exhaustiveness checks. */
export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'search_code'
  | 'search_codebase'
  | 'write_file'
  | 'run_command'
  | 'check_background_command'
  | 'get_problems'
  | 'remember'
  | 'search_chat_history'
  | 'spawn_subagent'
  | 'web_search'
  | 'web_fetch';

export interface ToolCall {
  tool: ToolName | string;
  args: Record<string, any>;
  /** Raw text the model produced, kept for transcript/debugging. */
  raw: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model as the tool's observation. */
  content: string;
}

export interface PendingEdit {
  id: string;
  uri: vscode.Uri;
  relativePath: string;
  originalText: string;
  newText: string;
  /** 'create' | 'modify' | 'delete' */
  kind: 'create' | 'modify' | 'delete';
}

export interface ToolExecContext {
  workspaceRoot: vscode.Uri;
  cancellation: vscode.CancellationToken;
  /** Proposes a file edit. Auto-applies immediately when approval is not required, else stages it for review. */
  proposeEdit: (edit: Omit<PendingEdit, 'id'>) => Promise<{ id: string; applied: boolean }>;
  /** Reads the "effective" content of a file — the latest still-pending proposal if one exists, else disk. */
  readEffective: (uri: vscode.Uri) => Promise<string | undefined>;
  /** Blocks until the user approves/denies a proposed shell command (or auto-approves per config). */
  requestCommandApproval: (command: string, callId: string) => Promise<boolean>;
  /** Semantic (embedding) or keyword-fallback search over the indexed workspace. */
  codebaseSearch: (query: string, k: number) => Promise<{ path: string; snippet: string; score: number }[]>;
  /** Item "memory": saves a durable fact to .forge/memory.md (de-duped), injected into every future system prompt. */
  rememberFact: (fact: string) => Promise<{ added: boolean; reason?: string }>;
  /** Item "memory": semantic (embedding) or keyword-fallback search over every past chat session's transcript. */
  chatMemorySearch: (query: string, k: number) => Promise<{ sessionId: string; sessionTitle: string; snippet: string; score: number }[]>;
  /**
   * Sub-agent spawning (item "ability to spawn sub agents"): runs `task` as
   * its own bounded, fully-autonomous nested agent turn and reports back a
   * summary. Implemented as a closure inside agentLoop.ts's runAgentTurn
   * (see spawnSubAgentTool in tools/subAgentTool.ts) because it needs the
   * same AgentDeps/cancellation/model-resolution machinery runAgentTurn
   * itself uses — nesting is capped (see MAX_SUBAGENT_DEPTH in agentLoop.ts)
   * so a sub-agent can't spawn an unbounded tree of sub-agents.
   */
  spawnSubAgent: (task: string, contextHint?: string) => Promise<{ ok: boolean; summary: string }>;
  /**
   * Web search (item "a terrific web search tool"). Undefined when
   * forge.webSearch.enabled is false — the web_search/web_fetch tool
   * wrappers check for this and return a clear "not enabled" message rather
   * than the model getting a confusing crash, since this is the one
   * category of tool that's off by default (see websearch/types.ts's doc
   * comment for why).
   */
  webSearch?: (query: string) => Promise<{ results: WebSearchResult[]; providerUsed?: string; warnings: string[] }>;
  webFetch?: (url: string, offset?: number, length?: number) => Promise<WebFetchResult>;
  /**
   * Item "ability to interact and use the terminal and run commands via the
   * terminal": long-running/background commands — see
   * tools/backgroundProcessManager.ts. Exposed as closures (matching every
   * other ToolExecContext capability) rather than the manager object itself,
   * so tool implementations stay decoupled from where/how it's stored.
   */
  startBackgroundCommand: (command: string, cwd: string) => { ok: true; id: string } | { ok: false; error: string };
  checkBackgroundCommand: (id: string) => { found: false } | { found: true; status: 'running' | 'exited'; exitCode: number | null; output: string; command: string; truncated: boolean };
  killBackgroundCommand: (id: string) => { found: false } | { found: true; alreadyExited: boolean };
  listBackgroundCommands: () => { id: string; command: string; cwd: string; status: 'running' | 'exited'; exitCode: number | null; startedAt: string }[];
  config: {
    autoApproveCommands: string[];
    requireApprovalForWrites: boolean;
    requireApprovalForCommands: boolean;
    maxContextFileKB: number;
  };
}

export interface ToolSpec {
  name: ToolName;
  /** Short human description injected into the system prompt. */
  describe: string;
  /** Example args shown to the model in the system prompt. */
  exampleArgs: Record<string, any>;
  run: (args: Record<string, any>, ctx: ToolExecContext) => Promise<ToolResult>;
}

/** Events streamed from the agent loop to the chat webview so the UI can render a live trace. */
export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'thought_start' }
  | { type: 'tool_call'; tool: string; args: Record<string, any>; callId: string }
  | { type: 'tool_result'; callId: string; ok: boolean; summary: string }
  | { type: 'pending_edit'; edit: PendingEditSerialized }
  | { type: 'edit_resolved'; id: string; accepted: boolean }
  | { type: 'approval_request'; kind: 'command'; callId: string; detail: string }
  | { type: 'final'; text: string; unverifiedClaims?: string[] }
  | { type: 'error'; message: string }
  | { type: 'metrics'; metrics: OllamaCallMetrics }
  | { type: 'checkpoint'; id: string; label: string }
  | { type: 'verify_start'; command: string; draftText: string }
  | { type: 'verify_result'; command: string; ok: boolean; summary: string }
  /** Item "Outcome mode introduces cheap tricks bypass" — see gamingDetection.ts. Emitted right after a verify_result whose check passed, only when that pass followed at least one failure and the heuristic scan flagged something in the writes made in response to it. Advisory only — never blocks the turn from completing. */
  | { type: 'verify_gaming_warning'; findings: { path: string; reason: string }[] }
  | { type: 'status'; text: string }
  | { type: 'subagent_start'; task: string; depth: number }
  | { type: 'subagent_result'; task: string; ok: boolean; summary: string; depth: number }
  | { type: 'done' }
  | { type: 'aborted' };

export interface PendingEditSerialized {
  id: string;
  relativePath: string;
  kind: 'create' | 'modify' | 'delete';
  diffPreview: string;
  additions: number;
  deletions: number;
}
