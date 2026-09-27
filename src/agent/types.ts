import * as vscode from 'vscode';
import { ChatMessage, OllamaCallMetrics } from '../ollama/types';
import { WebFetchResult, WebSearchResult } from '../websearch/types';
import { CostTier } from './taskCost';

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
  | 'plan_tasks'
  | 'update_task'
  | 'web_search'
  | 'web_fetch';

export interface ToolCall {
  tool: ToolName | string;
  args: Record<string, any>;
  /** Raw text the model produced, kept for transcript/debugging. */
  raw: string;
  /** True when parseToolCall fixed only missing closing `}`/`]` at the end of otherwise valid JSON. */
  jsonRepaired?: boolean;
}

/**
 * MCP standardization (0.14.0): a non-text content block an MCP tool
 * returned (an `image` or `resource` block per the MCP spec — see
 * mcp/mcpClient.ts's callTool()), carried through as "data to show the user"
 * rather than inlined into the model-facing observation text. Deliberately
 * generic/tool-agnostic (not MCP-specific by name) so a future built-in tool
 * that wants to hand back something similar (e.g. a generated image) doesn't
 * need a parallel mechanism — same reasoning as ToolResult.warning below.
 */
export interface ToolResultAttachment {
  /** The MCP content block's own `type` (`image`, `resource`, `audio`, or anything else a server invents — passed through verbatim, not validated against a closed set, since the spec allows servers to add block types). */
  type: string;
  mimeType?: string;
  /** Base64-encoded bytes, for an `image`/`audio` block's `data` field. */
  dataBase64?: string;
  /** A `resource`/`resource_link` block's URI, if it has one. */
  uri?: string;
  /** Human-readable text describing/embedding the resource (an embedded-resource block's own `text`, or a short fallback description) — shown in the UI, never fed to the model as part of the tool's `content` (see mcp/mcpManager.ts's buildToolSpec()). */
  text?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Text fed back to the model as the tool's observation. */
  content: string;
  /**
   * Optional, generic non-blocking advisory a tool can attach alongside a
   * successful (or failed) result — surfaced as its own visible, distinctly
   * styled transcript entry (see AgentEvent's 'tool_warning' and
   * agentLoop.ts's handling right after a tool call resolves), not just
   * buried in `content`'s text. First user: cost-aware task planning's
   * "this plan looks expensive, heads up" notice for autonomous modes that
   * don't pause for approval (agent/taskCost.ts's renderPlanCostWarning) —
   * kept generic rather than a bespoke event type so any future tool with a
   * similar "didn't block, but you should know" need can reuse it, the same
   * precedent gamingDetection.ts's verify-bypass warning already set for a
   * different, more specific scenario.
   */
  warning?: string;
  /**
   * MCP standardization (0.14.0): non-text content blocks (images, embedded
   * resources) an MCP tool returned alongside its text — shown to the user
   * as attachments on the tool's transcript card (see webview/protocol.ts's
   * 'tool' UiTranscriptEntry and media/webview.js's rendering), NOT inlined
   * into `content`. This is the concrete "distinguish data to show the user
   * from data to feed back into the loop" split: the model only ever sees a
   * one-line count-and-type note (see mcp/mcpManager.ts's buildToolSpec()),
   * never the raw base64/binary payload, which would be an expensive and
   * usually useless thing to push through a local model's context window.
   */
  attachments?: ToolResultAttachment[];
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
  /** Blocks until the user approves/denies a proposed shell command (or auto-approves per config). `workspaceRootFsPath` lets the dangerous-command check catch a recursive delete of the workspace itself, not just `/` or `~`. */
  requestCommandApproval: (command: string, callId: string, workspaceRootFsPath?: string) => Promise<boolean>;
  /**
   * Cost-aware task planning: blocks until the user approves/denies starting
   * a plan whose aggregate estimated cost crossed forge.taskLedger.expensivePlanReviewThreshold
   * (see agent/taskCost.ts and tools/taskLedgerTools.ts's planTasksTool).
   * Unlike requestCommandApproval, there is no auto-approve-pattern bypass
   * here — the CALLER (planTasksTool) already decides whether this is even
   * worth asking (mode, the reviewExpensivePlans setting, the threshold)
   * before ever calling this; once called, it always waits for a real
   * answer. `detail` is the full multi-line plan-with-cost-tiers text shown
   * in the approval card.
   */
  requestPlanApproval: (detail: string, callId: string) => Promise<boolean>;
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
   *
   * `resumeTaskId` (0.14.0 checkpoint/task-manifest unification): when set
   * to an existing task-ledger entry's id (typically one the model saw
   * marked "[~]"/"[!]" in the rendered ledger after an interruption — see
   * renderTaskLedgerForPrompt()), the sub-agent resumes that entry in place
   * (its status is flipped back to in_progress, no new ledger entry is
   * created) and is seeded with that entry's last known summary ahead of
   * `task`/`contextHint`. It's still a FRESH sub-agent context, not a
   * replayed transcript — see agentLoop.ts's spawnSubAgent closure and
   * CHANGELOG.md for why fresh-seeded-with-a-summary was chosen over full
   * replay. An id that no longer exists in the ledger is treated the same as
   * omitting resumeTaskId (a new entry is created instead) rather than
   * failing the call.
   */
  spawnSubAgent: (task: string, contextHint?: string, resumeTaskId?: string) => Promise<{ ok: boolean; summary: string }>;
  /**
   * Mandatory checkpoint-progress framework (item 4a/4b/4c — see
   * agent/taskLedger.ts's doc comment for the full rationale): backs the
   * plan_tasks/update_task tools (tools/taskLedgerTools.ts). Always present
   * whenever spawn_subagent is (same mode gating — see modes.ts's
   * ALL_TOOLS), independent of whether orchestration mode is toggled on for
   * this chat; ChatSession supplies the actual implementation (ledger
   * mutation + persistence + per-task report file), agentLoop.ts and the
   * tool wrappers only ever see this narrow interface.
   */
  taskLedger: {
    /**
     * Creates one or more new pending tasks (optionally children of an
     * existing one) and returns their ids. Each entry is either a bare
     * description string (spawn_subagent's auto-instrumentation call site —
     * always heuristic-costed, see TaskLedger.add()) or, for plan_tasks'
     * richer cost-aware call, an object carrying the model's own cost
     * estimate.
     */
    addTasks: (tasks: (string | { description: string; costTier?: CostTier; costNote?: string })[], parentTaskId?: string) => string[];
    /** Updates one task's status (and optionally its outcome summary). Returns false if `id` doesn't exist. */
    updateTask: (id: string, status: 'in_progress' | 'done' | 'failed', summary?: string) => boolean;
    /** Current ledger snapshot, for the update_task tool to report back a legible confirmation and for plan_tasks to avoid creating obvious duplicates, and for spawn_subagent's resumeTaskId lookup (see ToolExecContext.spawnSubAgent's doc comment). */
    list: () => { id: string; description: string; status: string; summary?: string; parentTaskId?: string; costTier?: CostTier; costNote?: string; checkpointId?: string }[];
  };
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
    /** Cost-aware task planning (forge.taskLedger.costAwarePlanning, default true) — see tools/taskLedgerTools.ts's planTasksTool and agent/taskCost.ts. When false, plan_tasks behaves exactly as it did before this feature: no cost tiers requested/stored, no review gate. */
    costAwarePlanningEnabled: boolean;
    /** forge.taskLedger.reviewExpensivePlans (default true) — whether an expensive plan pauses for approval at all (in a non-autonomous mode; see isAutonomousMode below). When false, an expensive plan still gets the non-blocking ToolResult.warning notice, just never blocks. */
    reviewExpensivePlansEnabled: boolean;
    /** forge.taskLedger.expensivePlanReviewThreshold (default 8) — the weighted plan-cost score (see agent/taskCost.ts's COST_WEIGHTS) at or above which a plan is considered worth flagging/reviewing. */
    expensivePlanReviewThreshold: number;
    /** Mirrors agentLoop.ts's own `autoMode` (isAutonomousMode(options.mode)) — Auto/Outcome never pause for approval by design (see modes.ts), so an expensive plan there can only ever get the non-blocking warning, never the blocking review card. */
    isAutonomousMode: boolean;
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

/**
 * Item "progress indicators — what file is being edited, is the model
 * thinking/reading/etc": a machine-readable category for a 'status' event,
 * alongside its human-readable text, so the UI can show a distinct icon per
 * kind of activity instead of a single generic spinner. See
 * agentLoop.ts's describeToolCall() for tool->activity mapping.
 */
export type AgentActivity = 'think' | 'read' | 'write' | 'delete' | 'run' | 'search' | 'diagnostics' | 'memory' | 'delegate' | 'verify' | 'web' | 'other';

/** Events streamed from the agent loop to the chat webview so the UI can render a live trace. */
export type AgentEvent =
  | { type: 'token'; text: string }
  | { type: 'thought_start' }
  | { type: 'tool_call'; tool: string; args: Record<string, any>; callId: string }
  | { type: 'tool_result'; callId: string; ok: boolean; summary: string; attachments?: ToolResultAttachment[] }
  | { type: 'pending_edit'; edit: PendingEditSerialized }
  | { type: 'edit_resolved'; id: string; accepted: boolean }
  | { type: 'approval_request'; kind: 'command' | 'plan_review'; callId: string; detail: string }
  | { type: 'final'; text: string; unverifiedClaims?: string[] }
  | { type: 'error'; message: string }
  | { type: 'metrics'; metrics: OllamaCallMetrics }
  | { type: 'checkpoint'; id: string; label: string }
  | { type: 'verify_start'; command: string; draftText: string }
  | { type: 'verify_result'; command: string; ok: boolean; summary: string }
  /** Item "Outcome mode introduces cheap tricks bypass" — see gamingDetection.ts. Emitted right after a verify_result whose check passed, only when that pass followed at least one failure and the heuristic scan flagged something in the writes made in response to it. Advisory only — never blocks the turn from completing. */
  | { type: 'verify_gaming_warning'; findings: { path: string; reason: string }[] }
  /** Generic, non-blocking advisory from any tool's result (see ToolResult.warning's doc comment) — rendered as its own visible transcript entry distinct from the tool call it came from. First user: cost-aware task planning's "this plan is expensive, heads up" notice in autonomous modes (agent/taskCost.ts's renderPlanCostWarning). */
  | { type: 'tool_warning'; text: string }
  | { type: 'status'; text: string; activity?: AgentActivity }
  | { type: 'subagent_start'; task: string; depth: number }
  | { type: 'subagent_result'; task: string; ok: boolean; summary: string; depth: number }
  /**
   * Fired every time the model-facing transcript (agentLoop.ts's local
   * `messages` array) grows by one entry — right after the system prompt is
   * (re)pinned, after every tool-call/tool-result round-trip, after every
   * plan-first/verify/hallucination-check nudge, and after the final answer
   * is recorded. This is the fix for the "an interrupted turn loses its
   * model-facing context, even though the UI transcript survives" gap:
   * before this event existed, ChatSession only learned the turn's updated
   * `modelHistory` once `runAgentTurn()` fully RETURNED (see
   * ChatSession.send()'s `this.modelHistory = result.messages`), so a
   * mid-turn crash/host-restart left the next turn resuming from the
   * PREVIOUS turn's history — Ollama-facing context for everything the
   * agent just did (file edits, commands, tool results) was gone, and a
   * fresh agent would re-discover/redo work it (from the UI's point of
   * view) already finished. ChatSession now applies this incrementally to
   * `this.modelHistory` and persists it exactly like it already does for
   * `uiHistory` via pushEntry() — see ChatSession.handleAgentEvent()'s
   * 'history_snapshot' case. `messages` here is always a fresh copy (never
   * the loop's own live array) so a subscriber can hold onto it safely.
   */
  | { type: 'history_snapshot'; messages: ChatMessage[] }
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
