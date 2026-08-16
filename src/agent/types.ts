import * as vscode from 'vscode';
import { OllamaCallMetrics } from '../ollama/types';

/** Names of every tool the agent may invoke. Kept as a union so callers get exhaustiveness checks. */
export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'search_code'
  | 'search_codebase'
  | 'write_file'
  | 'run_command'
  | 'get_problems'
  | 'remember'
  | 'search_chat_history';

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
