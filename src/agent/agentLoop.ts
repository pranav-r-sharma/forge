import { ReadCoverage } from './readCoverage';
import { TraceWriter, TraceInput, argsHash, describeArgsForTrace, hwForTrace, promptCacheMetricsForTrace } from './traceLog';
import type { HwSnapshot } from '../util/hwSampler';
import * as vscode from 'vscode';
import { keepAliveOpt } from '../ollama/client';
import { LlmProvider } from '../llm/provider';
import { ChatMessage, OllamaCallMetrics } from '../ollama/types';
import { AgentActivity, AgentEvent, ToolCall, ToolExecContext, ToolResult } from './types';
import { buildSystemPrompt, buildTurnContextPrefix } from './systemPrompt';
import { parseToolCall, looksLikeAbandonedToolCall, formatIncompleteActionNudge, formatIncompleteActionCapFailure, extractAbandonedActionTarget, preprocessHarmonyReply, containsHarmonyControls, detectForeignToolCall, formatForeignToolCallNudge, formatForeignToolCallCapFailure, assistantContentForHistory, tryAcceptNativeToolCall, formatToolCallForHistory, type ForeignToolCallFormat } from './toolProtocol';
import { parseStructuredResponse, STRUCTURED_RESPONSE_SCHEMA } from './structuredOutput';
import { generatePlanFirst, renderPlanFirstForPrompt } from './planFirst';
import { shouldCritique, critiqueEdit } from './selfCritique';
import { sampleBestOfNForRewrite, MIN_LINES_FOR_BEST_OF_N } from './bestOfN';
import { TOOL_MAP } from '../tools';
import { PendingEditManager } from '../tools/editApply';
import { ApprovalBroker } from './approvalBroker';
import { ForgeMode, isAutonomousMode, toolsAllowedInMode } from './modes';
import { HookRunner } from '../forge/hooks';
import { getConfig, resolveEffectiveMaxOutputTokens } from '../util/config';
import { logger } from '../util/logger';
import { resolveWorkspacePath, toRelative } from '../util/paths';
import { CompactionCache, PromptViewState, hardCapOversizedMessages, maybeCompact, pruneStaleReadsView, updateCharsPerToken, updatePromptView, DEFAULT_CHARS_PER_TOKEN } from './contextManager';
import { LoopDetector, formatLoopWarningMessage, signatureForStep } from './loopDetector';
import { unwrapNestedToolCall } from '../tools/argErrors';
import { unknownArgNotesForSpec } from '../tools/unknownToolArgs';
import {
  evaluateClaimedCommands,
  extractTaskCommandForms,
  findUnexercisedTaskForms,
  findUnverifiedClaims,
  formatTaskCommandNudge,
  formatUnresolvedFailureNudge,
  parseRunCommandExitCode,
  shouldSendTaskCommandNudge,
  taskCommandFormUnverifiedMarkers,
  unresolvedFailureMarker,
  type UnresolvedRunFailure,
} from './claimChecker';
import {
  extractRequirementsFromUserMessage,
  findRequirementsGateGaps,
  findRequirementsNudgeGaps,
  formatRequirementsGateNudge,
  extendRequirementsPromptView,
  renderRequirementsChecklistForPrompt,
  requirementGateMarkers,
  declinedRequirementNotes,
  openJudgmentRequirementNotes,
  updateRequirementsFromMessages,
  type RequirementsState,
} from './requirements';
import { runVerifyCommand } from './verifyCheck';
import { formatVerifyFinalNote, resolveVerifyCommandForFinal } from './verifyBeforeDone';
import { detectSuspiciousVerifyBypass } from './gamingDetection';
import { BackgroundProcessManager } from '../tools/backgroundProcessManager';
import { DynamicToolSpec } from '../mcp/mcpTypes';

export interface AgentDeps {
  ollama: LlmProvider;
  pendingEdits: PendingEditManager;
  approvalBroker: ApprovalBroker;
  hooks: HookRunner;
  codebaseSearch: (query: string, k: number) => Promise<{ path: string; snippet: string; score: number }[]>;
  rememberFact: (fact: string) => Promise<{ added: boolean; reason?: string }>;
  chatMemorySearch: (query: string, k: number) => Promise<{ sessionId: string; sessionTitle: string; snippet: string; score: number }[]>;
  /** Undefined when forge.webSearch.enabled is false — see ToolExecContext.webSearch's doc comment in agent/types.ts. */
  webSearch?: (query: string) => Promise<{ results: import('../websearch/types').WebSearchResult[]; providerUsed?: string; warnings: string[] }>;
  webFetch?: (url: string, offset?: number, length?: number) => Promise<import('../websearch/types').WebFetchResult>;
  /** Item "ability to interact and use the terminal" — see tools/backgroundProcessManager.ts. Workspace-scoped and shared across every chat tab, same as pendingEdits. */
  backgroundProcesses: BackgroundProcessManager;
  /** Tools contributed by connected MCP servers ("native MCP connection") — see mcp/mcpManager.ts. Undefined/empty when no servers are configured. Available in Agent/Auto/Outcome modes only (same reasoning as write_file/run_command — see the mode gating in the main loop below), never Ask/Plan. */
  mcpTools?: DynamicToolSpec[];
  /** See ToolExecContext.taskLedger's doc comment (agent/types.ts) — backs the plan_tasks/update_task tools and the automatic spawn_subagent ledger instrumentation below. Threaded straight through into toolCtx unchanged, and reused as-is for every nested sub-agent turn (same session, same ledger — see the spawnSubAgent closure passing `deps` through verbatim). */
  taskLedger: ToolExecContext['taskLedger'];
  /** Optional per-iteration trace sink (v0.15.0 §1.1). Tracing is best-effort and can never affect a turn. */
  trace?: TraceWriter;
  /** Latest hardware reading, for the trace only (see traceLog.ts hwForTrace). */
  hw?: () => HwSnapshot | undefined;
  workspaceRoot: vscode.Uri;
  workspaceName: string;
}

/** How many failed commands in a row make forge.thinking='auto' switch thinking on. */
export const THINKING_ESCALATION_FAILURES = 2;

/**
 * The `thinking` flag for a model call. 'auto' = fast (off) until the agent is visibly stuck — its commands have failed
 * THINKING_ESCALATION_FAILURES times in a row — then on. Measured on a 9B model (t03-add-function): thinking off failed the task,
 * thinking on solved it in 335 s; 'auto' spends the thinking budget only where it is needed. undefined = leave it to the model.
 */
export function thinkingForStep(mode: 'default' | 'off' | 'on' | 'auto', failedRunsInARow: number): boolean | undefined {
  if (mode === 'default') return undefined;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return failedRunsInARow >= THINKING_ESCALATION_FAILURES;
}

export interface AgentTurnOptions {
  mode: ForgeMode;
  /** Rendered environment facts (agent/environment.ts) for the system prompt: installed tools, likely test command. */
  environmentText?: string;
  rulesText?: string;
  /**
   * Durable facts from .forge/memory.md. NOTE: as of the prompt-prefix
   * stability fix, this (and milestonesText/projectLogText below) is no
   * longer spliced into the system message — see systemPrompt.ts's
   * buildSystemPrompt() doc comment for why content that grows every turn
   * doesn't belong there, and buildTurnContextPrefix()/this file's wiring
   * for where it goes instead (prepended to this turn's own user message).
   */
  memoryText?: string;
  /** Compact, mechanically-generated digest of prior turns this session (see chat/milestones.ts) — a cheap, always-available table of contents distinct from compaction's lossy LLM summary. See memoryText's note above on where this is actually injected. */
  milestonesText?: string;
  /** Item "documentation skill"/"unify into one system": the workspace-wide, cross-chat project log (see ChatStore.readProjectLogForPrompt()) — what makes a BRAND NEW chat aware of what's already happened in other chats, which milestonesText alone (this session's own history) can't provide. See memoryText's note above on where this is actually injected. */
  projectLogText?: string;
  /** Item 4a: mechanically-rendered task-ledger digest (see agent/taskLedger.ts's renderTaskLedgerForPrompt()) — what's already done/in-progress/failed this session, so a resumed or fresh agent doesn't redo finished work. Same "grows every turn, doesn't belong in the cached system message" reasoning as memoryText — see buildTurnContextPrefix's note above on where this is actually injected. */
  taskLedgerText?: string;
  /** Item 4c: per-chat orchestration-mode toggle — see ChatSession.orchestrationEnabled and systemPrompt.ts's buildSystemPrompt() doc comment on what this does and doesn't change. */
  orchestrationEnabled?: boolean;
  planContext?: string;
  /** Carried across turns so compaction doesn't re-summarize from scratch every time — see ChatSession. */
  compactionCache?: CompactionCache;
  /**
   * Optional "definition of done" shell command (Agent/Auto/Outcome modes —
   * see modes.ts's modeSupportsVerifyCommand and ChatSession.verifyCommand).
   * When set, a plain-text final answer isn't accepted at face value: Forge
   * runs this command first, and only actually ends the turn if it exits 0.
   * A non-zero exit gets fed back as evidence and the loop continues — this
   * is what makes OUTCOME mode's "keep iterating until it's actually true"
   * promise real instead of just a prompt asking the model to be honest.
   */
  verifyCommand?: string;
  /**
   * Nesting depth for spawn_subagent recursion — 0 (or unset) is a normal,
   * top-level user turn. Each spawn_subagent call increments this by 1 for
   * the nested runAgentTurn; once it reaches MAX_SUBAGENT_DEPTH, the
   * spawnSubAgent closure below refuses to nest any further, so a runaway
   * "sub-agent spawns a sub-agent spawns a sub-agent…" chain can't happen.
   */
  subAgentDepth?: number;
  /**
   * Overrides the mode-derived iteration cap (cfg.autoModeMaxIterations /
   * cfg.maxAgentIterations). Used to give a sub-agent turn its own, tighter
   * budget (forge.subAgentMaxIterations) instead of inheriting Auto mode's
   * effectively-unbounded cap.
   */
  maxIterationsOverride?: number;
  /**
   * Overrides forge.numCtx for this turn only — the per-chat "context limit"
   * setting (item "tweak context limits per chat"): a session using a small,
   * fast model can afford a larger context window than the global default,
   * since it leaves more memory/VRAM headroom than a larger model would.
   */
  numCtx?: number;
}

export interface AgentTurnResult {
  messages: ChatMessage[];
  compactionCache?: CompactionCache;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `call_${Date.now().toString(36)}_${callCounter}`;
}

/**
 * Absolute hard cap on spawn_subagent nesting depth, regardless of the
 * user-configurable `forge.maxSubAgentDepth` setting (see config.ts) — a
 * safety bound independent of the loop detector, so no setting value can
 * make a misbehaving model spawn sub-agents that spawn sub-agents forever.
 */
export const HARD_MAX_SUBAGENT_DEPTH = 4;

/**
 * Short, human-readable one-liner for what a tool call is about to do — item
 * "brief messages to indicate what the AI agent/model is doing" — paired
 * with a machine-readable `activity` category (item "progress indicators:
 * what file is being edited, is the model thinking/reading/etc") so the UI
 * can render a distinct icon per kind of activity instead of one generic
 * spinner for everything. Deliberately terse; the full detail is still in
 * the tool card that follows.
 */
function describeToolCall(tool: string, args: Record<string, any>): { text: string; activity: AgentActivity } {
  switch (tool) {
    case 'read_file':
      return { text: `Reading ${args?.path ?? 'a file'}…`, activity: 'read' };
    case 'list_dir':
      return { text: `Listing ${args?.path ?? 'workspace'}…`, activity: 'read' };
    case 'search_code':
      return { text: `Searching code for "${args?.query ?? ''}"…`, activity: 'search' };
    case 'search_codebase':
      return { text: `Searching the codebase for "${args?.query ?? ''}"…`, activity: 'search' };
    case 'write_file':
      return args?.delete
        ? { text: `Deleting ${args?.path ?? 'a file'}…`, activity: 'delete' }
        : { text: `Writing ${args?.path ?? 'a file'}…`, activity: 'write' };
    case 'run_command':
      return { text: `Running \`${args?.command ?? ''}\`…`, activity: 'run' };
    case 'check_background_command':
      return { text: 'Checking a background command…', activity: 'run' };
    case 'get_problems':
      return { text: `Checking diagnostics${args?.path ? ` for ${args.path}` : ''}…`, activity: 'diagnostics' };
    case 'remember':
      return { text: 'Saving a fact to memory…', activity: 'memory' };
    case 'search_chat_history':
      return { text: `Searching past chats for "${args?.query ?? ''}"…`, activity: 'search' };
    case 'spawn_subagent':
      return { text: `Delegating to a sub-agent: ${truncateOneLine(String(args?.task ?? ''), 80)}`, activity: 'delegate' };
    case 'web_search':
      return { text: `Searching the web for "${truncateOneLine(String(args?.query ?? ''), 70)}"…`, activity: 'web' };
    case 'web_fetch':
      return { text: `Fetching ${truncateOneLine(String(args?.url ?? ''), 80)}…`, activity: 'web' };
    default:
      return { text: `Calling ${tool}…`, activity: 'other' };
  }
}

function truncateOneLine(s: string, maxLen: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

/**
 * Turns one raw model response into (a) the tool call to execute, if any,
 * and (b) the human-readable text to actually show/check for a final
 * answer. When structured output is enabled, `fullText` is expected to be a
 * JSON envelope (see structuredOutput.ts) — but a local model not respecting
 * the requested format is an expected, not exceptional, outcome, so an
 * unparseable envelope falls straight through to the ordinary defensive
 * fenced-block parser rather than erroring the turn. Exported for direct
 * unit testing.
 */
export function resolveModelResponse(fullText: string, structuredOutputEnabled: boolean): { call: ToolCall | null; displayText: string; reasoning?: string } {
  const harmony = preprocessHarmonyReply(fullText);
  const parseSource = harmony.textForParsing;
  if (structuredOutputEnabled) {
    const structured = parseStructuredResponse(parseSource);
    if (structured) {
      if (structured.call) return { call: structured.call, displayText: harmony.displayText || fullText, reasoning: harmony.reasoning || undefined };
      return { call: null, displayText: structured.finalText ?? harmony.displayText, reasoning: harmony.reasoning || undefined };
    }
  }
  const call = parseToolCall(parseSource);
  const displayText = containsHarmonyControls(fullText) ? harmony.displayText : fullText;
  return { call, displayText, reasoning: harmony.reasoning || undefined };
}

/** Investigation-only tools — allowed while a pending unfinished write is outstanding. */
const PENDING_ACTION_BYPASS_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'get_problems',
]);

type PendingActionTarget = { tool: string; path: string; redirectsUsed: number };

function normalizeToolPath(workspaceRoot: vscode.Uri, relPath: string): string | undefined {
  try {
    return toRelative(workspaceRoot, resolveWorkspacePath(workspaceRoot, relPath));
  } catch {
    return relPath.replace(/^\/+/, '').replace(/^\.\/+/, '');
  }
}

function toolCallMatchesPendingPath(call: ToolCall, pendingPath: string, workspaceRoot: vscode.Uri): boolean {
  const argPath: unknown = call.args?.path ?? call.args?.file;
  if (typeof argPath !== 'string') return false;
  const a = normalizeToolPath(workspaceRoot, pendingPath);
  const b = normalizeToolPath(workspaceRoot, argPath);
  return a !== undefined && b !== undefined && a === b;
}

/**
 * Runs one full agent "turn": repeatedly calls the model, executes at most
 * one tool per round-trip, and feeds the result back — a ReAct-style loop —
 * until the model produces a plain-text final answer, the iteration cap is
 * hit, or the operation is cancelled. Streams progress via `emit`.
 *
 * `options.mode` gates which tools the model is even told about / allowed to
 * call (see modes.ts): Ask is read-only, Plan has no tools at all and must
 * answer in plain text, Agent has everything.
 */
export async function runAgentTurn(
  history: ChatMessage[],
  userMessage: string,
  deps: AgentDeps,
  emit: (event: AgentEvent) => void,
  cancellation: vscode.CancellationToken,
  model: string,
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const cfg = getConfig();
  const autoMode = isAutonomousMode(options.mode);
  // Auto and Outcome modes are fully autonomous (item #2, and the 0.7.0 fix
  // for Outcome mode silently still requiring approvals): no approval gate
  // for writes. Command approval is handled by ApprovalBroker itself
  // (ChatSession wires its getRequireApproval() to be mode-aware) — the
  // dangerous-command denylist in commandTool.ts still applies there
  // regardless of mode.
  const requireApprovalForWrites = autoMode ? false : cfg.requireApprovalForWrites;
  const maxIterations = options.maxIterationsOverride ?? (autoMode ? cfg.autoModeMaxIterations : cfg.maxAgentIterations);
  // Per-chat context-limit override (item "tweak context limits per chat" —
  // a session pinned to a light/small model can afford a bigger window than
  // the global default since it leaves more memory/VRAM headroom).
  const numCtx = options.numCtx ?? cfg.numCtx;
  const subAgentDepth = options.subAgentDepth ?? 0;

  const messages: ChatMessage[] = [...history];
  // See AgentEvent's 'history_snapshot' doc comment (types.ts) for the full
  // "why": every mutation of `messages` from here on goes through this
  // wrapper instead of a bare push, so ChatSession can persist the
  // model-facing transcript incrementally — the same way uiHistory already
  // persists per UI event — instead of only learning about it after the
  // whole turn returns. Emits a fresh copy each time; never the live array.
  const pushMsg = (msg: ChatMessage) => {
    messages.push(msg);
    emit({ type: 'history_snapshot', messages: [...messages] });
  };
  const pushAssistant = (raw: string, executedCall?: ToolCall) =>
    pushMsg({
      role: 'assistant',
      content: executedCall
        ? formatToolCallForHistory({ tool: executedCall.tool, args: executedCall.args })
        : assistantContentForHistory(raw),
    });
  const allowedTools = new Set(toolsAllowedInMode(options.mode));
  // Native MCP tool connection: merged in alongside the built-in tool map at
  // every lookup site below, namespaced (mcp_<server>_<tool>) so it can
  // never collide with a built-in name — see mcp/mcpManager.ts.
  const mcpToolMap = new Map((deps.mcpTools || []).map((t) => [t.name, t] as const));
  // Opt-in constrained-decoding tool-call contract (see structuredOutput.ts)
  // — never applies in Plan mode, which has no tools and always replies in
  // plain text regardless of this setting.
  const structuredOutputEnabled = cfg.structuredOutputEnabled && options.mode !== 'plan';
  const loopDetector = new LoopDetector();
  let compactionCache = options.compactionCache;
  // Item "Outcome mode introduces cheap tricks bypass" (gamingDetection.ts):
  // tracks write_file calls made since the last verify attempt, so that if
  // the NEXT verify attempt passes right after a failure, the writes that
  // supposedly fixed it can be scanned for signs the check was gamed rather
  // than the goal actually met. Reset after every verify attempt (pass or
  // fail) so the window always covers exactly "what changed in response to
  // the most recent failure," not this turn's whole edit history.
  let sawFailedVerify = false;
  let writesSinceLastVerify: { path: string; text: string }[] = [];

  // Mode/rules can change between turns (user flips the mode dropdown, edits
  // a rule file, etc.) — always refresh the system prompt rather than trusting
  // whatever was pinned as messages[0] from a previous turn. Memory/project-
  // log/milestones text is deliberately NOT passed here — see
  // buildSystemPrompt()'s doc comment on prompt-prefix stability; it's
  // prepended to this turn's own user message below instead.
  const systemPrompt = buildSystemPrompt(deps.workspaceName, options.mode, {
    rulesText: options.rulesText,
    planContext: options.planContext,
    mcpTools: deps.mcpTools,
    structuredOutput: structuredOutputEnabled,
    orchestrationEnabled: options.orchestrationEnabled,
    environmentText: options.environmentText,
    terse: cfg.terseSteps,
  });
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: systemPrompt };
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  const requirementsActive = cfg.requirementsEnabled && (options.subAgentDepth ?? 0) === 0;
  let requirementsState: RequirementsState | undefined;
  if (requirementsActive) {
    requirementsState = extractRequirementsFromUserMessage(userMessage);
  }

  const turnContextPrefix = buildTurnContextPrefix({
    memoryText: options.memoryText,
    projectLogText: options.projectLogText,
    milestonesText: options.milestonesText,
    taskLedgerText: options.taskLedgerText,
  });

  // Optional "separate planner/executor prompts" pass (forge.planFirst.enabled)
  // — one extra no-tool-schema reasoning call before the main ReAct loop
  // starts, grounded with a few codebase-search hits. Never in Ask (nothing
  // to plan — it's read-only Q&A) or Plan mode (which IS the plan). See
  // planFirst.ts's doc comment for the rationale.
  let planBlock = '';
  const planFirstEnabled = cfg.planFirstEnabled && (options.mode === 'agent' || options.mode === 'auto' || options.mode === 'outcome');
  if (planFirstEnabled) {
    emit({ type: 'status', text: 'Planning before acting…', activity: 'think' });
    const planText = await generatePlanFirst({
      ollama: deps.ollama,
      model,
      userMessage,
      recentMessages: messages.slice(-6),
      codebaseSearch: deps.codebaseSearch,
      signal: cancellationToAbortSignal(cancellation),
      numCtx,
    });
    if (planText) planBlock = renderPlanFirstForPrompt(planText) + '\n\n';
  }

  pushMsg({ role: 'user', content: `${turnContextPrefix}${planBlock}${userMessage}` });

  const taskCommandForms = extractTaskCommandForms(userMessage);

  const toolCtx: ToolExecContext = {
    workspaceRoot: deps.workspaceRoot,
    cancellation,
    proposeEdit: async (edit) => deps.pendingEdits.propose(edit, requireApprovalForWrites),
    readEffective: (uri) => deps.pendingEdits.readEffective(uri),
    requestCommandApproval: (command, callId) => deps.approvalBroker.requestCommandApproval(command, callId, deps.workspaceRoot.fsPath),
    requestPlanApproval: (detail, callId) => deps.approvalBroker.requestPlanApproval(detail, callId),
    codebaseSearch: deps.codebaseSearch,
    rememberFact: deps.rememberFact,
    chatMemorySearch: deps.chatMemorySearch,
    webSearch: deps.webSearch,
    webFetch: deps.webFetch,
    taskLedger: deps.taskLedger,
    startBackgroundCommand: (command, cwd) => deps.backgroundProcesses.start(command, cwd),
    checkBackgroundCommand: (id) => deps.backgroundProcesses.check(id),
    killBackgroundCommand: (id) => deps.backgroundProcesses.kill(id),
    listBackgroundCommands: () => deps.backgroundProcesses.list(),
    spawnSubAgent: async (task, contextHint, resumeTaskId) => {
      const configuredMaxDepth = Math.min(Math.max(1, cfg.maxSubAgentDepth), HARD_MAX_SUBAGENT_DEPTH);
      if (subAgentDepth >= configuredMaxDepth) {
        return {
          ok: false,
          summary: `Refused: sub-agent nesting depth limit (${configuredMaxDepth}, see forge.maxSubAgentDepth) reached. Do this work directly instead of spawning another sub-agent.`,
        };
      }
      const subCfg = getConfig();
      const subModel = subCfg.subAgentModel || model;
      emit({ type: 'subagent_start', task, depth: subAgentDepth + 1 });
      emit({ type: 'status', text: `Sub-agent (depth ${subAgentDepth + 1}) starting: ${truncateOneLine(task, 90)}`, activity: 'delegate' });
      // Mandatory checkpoint-progress framework (item 4a/4b/4c): every
      // spawn_subagent call is automatically recorded as a task-ledger entry
      // — no model discipline required, unlike plan_tasks/update_task which
      // the model has to remember to call. This is what makes "a new agent
      // picks up after an interruption instead of redoing work" actually
      // hold for the most common form of delegated work (sub-agents) even
      // when orchestration mode is off and the model never touches the
      // ledger tools itself. Guarded — deps.taskLedger is only guaranteed
      // present for real ChatSession-driven turns; some direct/test callers
      // of runAgentTurn don't wire it up, and that must never break
      // spawn_subagent itself.
      //
      // 0.14.0 resumeTaskId: if the caller named an EXISTING ledger entry to
      // resume (typically one it saw marked "[~]"/"[!]" after an
      // interruption — see renderTaskLedgerForPrompt()), reuse that entry
      // in place instead of creating a new one, and fold its last known
      // progress into the sub-agent's seeded context. A stale/unknown id is
      // treated exactly like omitting resumeTaskId (falls through to
      // creating a fresh entry) rather than failing the whole call — a
      // model hallucinating or reusing a since-deleted id shouldn't block
      // real work from happening.
      const resumedEntry = resumeTaskId ? deps.taskLedger?.list().find((e) => e.id === resumeTaskId) : undefined;
      let ledgerTaskId: string | undefined;
      let resumeNote: string | undefined;
      if (resumedEntry) {
        ledgerTaskId = resumedEntry.id;
        deps.taskLedger!.updateTask(ledgerTaskId, 'in_progress');
        resumeNote = `[Resuming task ${resumedEntry.id}, previously "${resumedEntry.status}"]\n${resumedEntry.summary ? `Last known progress: ${resumedEntry.summary}` : 'No progress summary was recorded before this task was interrupted — treat the task description as the only ground truth and verify current state before assuming anything is already done.'}`;
      } else {
        ledgerTaskId = deps.taskLedger?.addTasks([task])[0];
        if (ledgerTaskId) deps.taskLedger!.updateTask(ledgerTaskId, 'in_progress');
      }
      const subUserMessage = [resumeNote, task, contextHint ? `[Context from parent agent]\n${contextHint}` : undefined].filter(Boolean).join('\n\n');
      // Sub-agents only ever report their final answer back to the parent —
      // their own tool-call chatter is real (it still shows up via `emit`
      // as ordinary events, tagged nowhere as "sub" today, which is a known
      // simplification — see CHANGELOG) but what matters for the parent's
      // transcript is just the outcome, captured below from 'final'/'error'/
      // 'aborted'.
      let outcome: { ok: boolean; summary: string } = { ok: false, summary: 'Sub-agent produced no result.' };
      try {
        await runAgentTurn(
          [],
          subUserMessage,
          deps,
          (subEvent) => {
            if (subEvent.type === 'final') {
              outcome = { ok: true, summary: subEvent.text };
            } else if (subEvent.type === 'error') {
              outcome = { ok: false, summary: subEvent.message };
            } else if (subEvent.type === 'aborted') {
              outcome = { ok: false, summary: 'Sub-agent was stopped before finishing.' };
            }
            // Sub-agent tool calls/tokens are intentionally not forwarded to
            // the parent's transcript — only start/result and this progress
            // status are, so a sub-agent's own step-by-step trace doesn't
            // flood the parent conversation. The full trace is still visible
            // if you open the sub-agent's own emitted events in dev tools.
          },
          cancellation, // shared token: a user Stop on the parent also stops any in-flight sub-agent.
          subModel,
          {
            mode: 'auto', // sub-agents are always fully autonomous — no approval prompts (see isAutonomousMode).
            rulesText: options.rulesText,
            memoryText: options.memoryText,
            projectLogText: options.projectLogText,
            subAgentDepth: subAgentDepth + 1,
            maxIterationsOverride: subCfg.subAgentMaxIterations,
            numCtx,
          }
        );
      } catch (err: any) {
        outcome = { ok: false, summary: `Sub-agent crashed: ${err?.message || err}` };
      }
      emit({ type: 'subagent_result', task, ok: outcome.ok, summary: outcome.summary, depth: subAgentDepth + 1 });
      if (ledgerTaskId) deps.taskLedger!.updateTask(ledgerTaskId, outcome.ok ? 'done' : 'failed', outcome.summary);
      return outcome;
    },
    config: {
      autoApproveCommands: cfg.autoApproveCommands,
      requireApprovalForWrites,
      requireApprovalForCommands: autoMode ? false : cfg.requireApprovalForCommands,
      maxContextFileKB: cfg.maxContextFileKB,
      costAwarePlanningEnabled: cfg.costAwarePlanningEnabled,
      reviewExpensivePlansEnabled: cfg.reviewExpensivePlansEnabled,
      expensivePlanReviewThreshold: cfg.expensivePlanReviewThreshold,
      isAutonomousMode: autoMode,
    },
  };

  /** Builds the trimmed view actually sent to Ollama — never mutates `messages`, the archival/persisted transcript. See contextManager.ts. */
  let lastViewEvent: 'mask' | 'compact' | undefined;
  let lastEstTokens: number | undefined;
  let requirementsPromptView: ChatMessage[] | undefined;
  async function buildPromptView(): Promise<ChatMessage[]> {
    lastViewEvent = undefined;
    if (cfg.contextAppendOnly) {
      // Append-only path (v0.15.0 §2.1): nothing already sent is rewritten except in a deliberate, batched event — see updatePromptView().
      const r = await updatePromptView(messages, compactionCache, {
        model,
        numCtx,
        ollama: deps.ollama,
        signal: cancellationToAbortSignal(cancellation),
        highWaterPct: cfg.contextHighWaterPct,
        lowWaterPct: cfg.contextLowWaterPct,
        singleMessageSharePct: cfg.singleMessageSharePct,
        pinnedUserMaxChars: cfg.contextPinnedUserMaxChars,
      });
      compactionCache = r.state;
      lastViewEvent = r.event?.kind;
      lastEstTokens = r.estTokens;
      if (r.event) {
        requirementsPromptView = undefined;
      }
      let view = r.view;
      if (requirementsActive && cfg.requirementsShowInPrompt && requirementsState) {
        requirementsState = updateRequirementsFromMessages(requirementsState, messages);
        const checklist = renderRequirementsChecklistForPrompt(requirementsState);
        view = extendRequirementsPromptView(requirementsPromptView, view, checklist);
        requirementsPromptView = view;
      }
      return view;
    }
    const pruned = pruneStaleReadsView(messages);
    const compacted = await maybeCompact(pruned, compactionCache, model, numCtx, deps.ollama, cancellationToAbortSignal(cancellation));
    compactionCache = compacted.cache;
    let view = hardCapOversizedMessages(compacted.promptMessages);
    if (requirementsActive && cfg.requirementsShowInPrompt && requirementsState) {
      requirementsState = updateRequirementsFromMessages(requirementsState, messages);
      const checklist = renderRequirementsChecklistForPrompt(requirementsState);
      view = extendRequirementsPromptView(requirementsPromptView, view, checklist);
      requirementsPromptView = view;
    }
    return view;
  }

  let hallucinationNudges = 0;
  let claimedCommandNudges = 0;
  let taskCommandNudges = 0;
  let lastUnexercisedTaskFormsSeen: string[] | undefined;
  let unresolvedFailureNudges = 0;
  let unresolvedRunFailure: UnresolvedRunFailure | undefined;
  let commandsExecutedThisTurn: string[] = [];
  let filesWrittenThisTurn: string[] = [];
  let foreignFormatNudges = 0;
  let incompleteActionNudges = 0;
  let requirementsNudges = 0;
  let pendingActionTarget: PendingActionTarget | undefined;
  /** Consecutive failed run_command results (tests/build still failing) — drives forge.thinking='auto': the agent is stuck, so let the model think. */
  let failedRunsInARow = 0;

  // ---- trace + read-coverage (v0.15.0 §1.1/§1.2): measurement only, guarded so it can never break a turn ----
  const turnId = Date.now().toString(36);
  const readCoverage = new ReadCoverage();
  let iterState = { iter: 0, promptChars: 0, promptMsgs: 0, staleReadStubs: 0, compacted: false, modelMs: 0, metrics: undefined as OllamaCallMetrics | undefined, viewEvent: undefined as 'mask' | 'compact' | undefined, estPromptTokens: undefined as number | undefined, thinking: undefined as boolean | undefined };
  const traceIter = (extra: Partial<TraceInput>) => {
    if (!deps.trace) return;
    try {
      const m = iterState.metrics;
      let hw: ReturnType<typeof hwForTrace>;
      try {
        hw = hwForTrace(deps.hw?.());
      } catch {
        hw = undefined; // a failing hardware reader must not cost us the rest of the record
      }
      deps.trace.write({
        turnId,
        iter: iterState.iter,
        depth: subAgentDepth,
        model,
        mode: options.mode,
        promptChars: iterState.promptChars,
        promptMsgs: iterState.promptMsgs,
        staleReadStubs: iterState.staleReadStubs,
        compacted: iterState.compacted,
        viewEvent: iterState.viewEvent,
        estPromptTokens: iterState.estPromptTokens,
        modelMs: iterState.modelMs,
        ...promptCacheMetricsForTrace(m, iterState.estPromptTokens),
        evalTokens: m?.evalTokens,
        tokPerSec: m?.tokensPerSecond,
        promptEvalMs: m?.promptEvalDurationMs,
        loadMs: m?.loadDurationMs,
        finishReason: m?.finishReason,
        thinking: iterState.thinking,
        hw,
        ...extra,
      });
    } catch {
      /* tracing must never affect the turn */
    }
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (cancellation.isCancellationRequested) {
      emit({ type: 'aborted' });
      return { messages, compactionCache };
    }

    const promptView = await buildPromptView();
    iterState = {
      iter: iteration,
      promptChars: promptView.reduce((n, m) => n + m.content.length, 0),
      promptMsgs: promptView.length,
      staleReadStubs: promptView.filter((m) => m.role === 'user' && m.content.startsWith('[Tool "read_file" result — superseded]')).length,
      compacted: promptView.some((m) => m.content.startsWith('[Earlier conversation summary')),
      modelMs: 0,
      metrics: undefined,
      viewEvent: lastViewEvent,
      estPromptTokens: lastEstTokens,
      thinking: thinkingForStep(cfg.thinking, failedRunsInARow),
    };
    const modelStartedAt = Date.now();

    emit({ type: 'thought_start' });
    // Item "brief messages indicating what the AI agent/model is doing":
    // announce the model doing the thinking before the (potentially slow)
    // call starts, not just after a tool call is chosen.
    emit({ type: 'status', text: subAgentDepth > 0 ? `Sub-agent thinking with ${model}…` : `Thinking with ${model}…`, activity: 'think' });
    let fullText = '';
    try {
      fullText = await deps.ollama.chat({
        model,
        messages: promptView,
        temperature: cfg.temperature,
        signal: cancellationToAbortSignal(cancellation),
        numCtx,
        numBatch: cfg.ollamaNumBatch > 0 ? cfg.ollamaNumBatch : undefined,
        keepAliveMinutes: keepAliveOpt(cfg.keepAliveMinutes),
        format: structuredOutputEnabled ? STRUCTURED_RESPONSE_SCHEMA : undefined,
        thinking: thinkingForStep(cfg.thinking, failedRunsInARow),
        maxTokens: resolveEffectiveMaxOutputTokens(cfg.maxOutputTokens, numCtx, cfg.maxOutputTokensCeiling),
        onToken: (token) => emit({ type: 'token', text: token }),
        onMetrics: (metrics) => {
          iterState.metrics = metrics;
          emit({ type: 'metrics', metrics });
        },
      });
    } catch (err: any) {
      // A user-initiated Stop shows up here as an AbortError — that's not a
      // connectivity failure, so don't show the misleading "Could not reach
      // Ollama" error toast for it (see client.ts, item #8).
      if (err?.name === 'AbortError' || cancellation.isCancellationRequested) {
        emit({ type: 'aborted' });
        return { messages, compactionCache };
      }
      logger.error('agent chat() failed', err);
      emit({ type: 'error', message: err?.message || String(err) });
      return { messages, compactionCache };
    }

    iterState.modelMs = Date.now() - modelStartedAt;
    if (cfg.contextAppendOnly) {
      // Learn this model's chars/token from the runtime's real prompt-token count so the water marks use measured sizes, not a guess.
      const m = iterState.metrics;
      const curCpt = (compactionCache as PromptViewState | undefined)?.cpt || DEFAULT_CHARS_PER_TOKEN;
      const total = m?.promptTotalTokens ?? (m?.promptTokens !== undefined && m.promptTokens >= 0.7 * (iterState.promptChars / curCpt) ? m.promptTokens : undefined);
      const nextCpt = updateCharsPerToken(curCpt, iterState.promptChars, total);
      compactionCache = { throughIndex: 0, summary: '', ...(compactionCache || {}), cpt: nextCpt } as PromptViewState;
    }

    if (cancellation.isCancellationRequested) {
      emit({ type: 'aborted' });
      return { messages, compactionCache };
    }

    // structuredOutputEnabled: try the JSON envelope first, but a local model
    // ignoring the requested format from time to time is expected, not
    // exceptional — resolveModelResponse() falls back to the ordinary
    // defensive fenced-block parser whenever the envelope doesn't parse, so
    // a turn never fails just because the model drifted from the schema.
    let { call, displayText } = options.mode === 'plan'
      ? { call: null as ToolCall | null, displayText: fullText }
      : resolveModelResponse(fullText, structuredOutputEnabled);

    const knownToolNames = [...Object.keys(TOOL_MAP), ...mcpToolMap.keys()];
    const foreignCall = !call && options.mode !== 'plan' ? detectForeignToolCall(fullText) : null;
    let nativeAcceptedFormat: ForeignToolCallFormat | undefined;
    if (!call && foreignCall) {
      const accepted = tryAcceptNativeToolCall(foreignCall, knownToolNames);
      if (accepted) {
        call = { ...accepted.call, raw: fullText };
        nativeAcceptedFormat = accepted.format;
      }
    }
    if (foreignCall && !call && foreignFormatNudges < 3) {
      foreignFormatNudges++;
      pushAssistant(fullText);
      pushMsg({ role: 'user', content: formatForeignToolCallNudge(foreignCall, knownToolNames, fullText) });
      traceIter({ note: 'foreign-tool-call-nudge' });
      continue;
    }
    if (foreignCall && !call && foreignFormatNudges >= 3) {
      const failureNote = formatForeignToolCallCapFailure(foreignCall, foreignFormatNudges);
      pushAssistant(fullText);
      const finalText = `${displayText.trim()}\n\n[System] ${failureNote}`.trim();
      traceIter({ note: 'incomplete-action-cap', final: true });
      pendingActionTarget = undefined;
      emit({ type: 'final', text: finalText });
      emit({ type: 'done' });
      return { messages, compactionCache };
    }

    const lengthTruncated = iterState.metrics?.finishReason === 'length';
    // A model can also abandon an action mid-JSON on its OWN stop token (finishReason 'stop', not 'length') —
    // e.g. it finishes a long write_file's content and, out of habit, types a closing ``` without ever closing
    // the JSON. That leaves a `"tool":"..."` fragment that parseToolCall correctly refuses to parse, but the
    // fragment must not be silently accepted as a final answer either (found via the t07-build-from-scratch
    // acceptance test — see PROGRESS.md — where this was 100% reproducible on a large new-file write).
    const abandonedAction = !call && !lengthTruncated && options.mode !== 'plan' && looksLikeAbandonedToolCall(fullText);
    const incompleteReply = !call && options.mode !== 'plan' && (lengthTruncated || abandonedAction);
    if (incompleteReply && incompleteActionNudges < 3) {
      // What we have is an INCOMPLETE action or thought, not a final answer — treating it as one is how a run
      // silently "finishes" without doing the work. Keep the partial text in the transcript and ask the model to carry on with an action.
      incompleteActionNudges++;
      pushAssistant(fullText);
      pushMsg({ role: 'user', content: formatIncompleteActionNudge(fullText, lengthTruncated) });
      const nudgeTarget = extractAbandonedActionTarget(fullText);
      if (nudgeTarget?.path) {
        pendingActionTarget = { tool: nudgeTarget.tool, path: nudgeTarget.path, redirectsUsed: 0 };
      }
      traceIter({ note: lengthTruncated ? 'truncated-reply-nudge' : 'abandoned-action-nudge' });
      continue;
    }

    if (incompleteReply && incompleteActionNudges >= 3) {
      const failureNote = formatIncompleteActionCapFailure(fullText, incompleteActionNudges);
      pushAssistant(fullText);
      const finalText = `${displayText.trim()}\n\n[System] ${failureNote}`.trim();
      traceIter({ note: 'incomplete-action-cap', final: true });
      pendingActionTarget = undefined;
      emit({ type: 'final', text: finalText });
      emit({ type: 'done' });
      return { messages, compactionCache };
    }

    if (!call) {
      // Item #10: catch the model claiming it made a change ("created
      // `foo.ts`") that no write_file call actually backs up, and give it a
      // couple of chances to either actually do it or correct the claim,
      // instead of shipping a confidently wrong final answer.
      const unverified = findUnverifiedClaims(displayText, messages);
      if (unverified.length > 0 && hallucinationNudges < 2) {
        hallucinationNudges++;
        pushAssistant(fullText);
        const nudge = `[System check] You said you changed ${unverified.map((p) => `\`${p}\``).join(', ')}, but no write_file call for ${unverified.length === 1 ? 'that path' : 'those paths'} appears anywhere in this conversation. If you meant to make that change, call write_file now. If it's already done and this check is wrong, just continue — but don't simply repeat the same claim without acting or correcting it.`;
        pushMsg({ role: 'user', content: nudge });
        traceIter({ note: 'unverified-claim-nudge' });
        continue;
      }
      const unexercisedTaskForms = findUnexercisedTaskForms(taskCommandForms, commandsExecutedThisTurn);
      const claimedCmd = evaluateClaimedCommands(
        displayText,
        commandsExecutedThisTurn,
        filesWrittenThisTurn,
        [],
      );
      const hasClaimedCmdIssues =
        claimedCmd.unrunCommands.length > 0 || claimedCmd.perFileGaps.length > 0;
      const hasTaskFormIssues = unexercisedTaskForms.length > 0;

      if (
        hasTaskFormIssues &&
        shouldSendTaskCommandNudge(unexercisedTaskForms, lastUnexercisedTaskFormsSeen, taskCommandNudges)
      ) {
        taskCommandNudges++;
        lastUnexercisedTaskFormsSeen = [...unexercisedTaskForms];
        pushAssistant(fullText);
        pushMsg({ role: 'user', content: formatTaskCommandNudge(unexercisedTaskForms) });
        traceIter({ note: 'task-command-nudge' });
        continue;
      }
      if (hasClaimedCmdIssues && claimedCommandNudges < 1) {
        claimedCommandNudges++;
        pushAssistant(fullText);
        pushMsg({ role: 'user', content: claimedCmd.nudgeMessage });
        traceIter({ note: claimedCmd.nudgeTraceNote ?? 'claimed-command-nudge' });
        continue;
      }
      if (unresolvedRunFailure && unresolvedFailureNudges < 1) {
        unresolvedFailureNudges++;
        pushAssistant(fullText);
        pushMsg({ role: 'user', content: formatUnresolvedFailureNudge(unresolvedRunFailure) });
        traceIter({ note: 'unresolved-failure-nudge' });
        continue;
      }
      let requirementsGateMissing: ReturnType<typeof findRequirementsGateGaps> = [];
      let requirementsNudgeMissing: ReturnType<typeof findRequirementsNudgeGaps> = [];
      if (requirementsActive && requirementsState) {
        requirementsState = updateRequirementsFromMessages(requirementsState, messages);
        requirementsGateMissing = findRequirementsGateGaps(requirementsState);
        requirementsNudgeMissing = findRequirementsNudgeGaps(requirementsState);
        const overlapsTaskNudge =
          hasTaskFormIssues &&
          requirementsNudgeMissing.some((it) => unexercisedTaskForms.some((f) => it.text.includes(f) || f.includes(it.text.slice(0, 30))));
        if (
          requirementsNudgeMissing.length > 0 &&
          !overlapsTaskNudge &&
          requirementsNudges < cfg.requirementsMaxNudges
        ) {
          requirementsNudges++;
          pushAssistant(fullText);
          pushMsg({ role: 'user', content: formatRequirementsGateNudge(requirementsNudgeMissing) });
          traceIter({ note: 'requirements-gate-nudge' });
          continue;
        }
      }
      const unverifiedAll = [
        ...unverified,
        ...claimedCmd.unverifiedMarkers,
        ...(hasTaskFormIssues ? taskCommandFormUnverifiedMarkers(unexercisedTaskForms) : []),
        ...(unresolvedRunFailure ? [unresolvedFailureMarker(unresolvedRunFailure)] : []),
        ...(requirementsGateMissing.length > 0 ? requirementGateMarkers(requirementsGateMissing) : []),
        ...(requirementsState
          ? [
              ...declinedRequirementNotes(requirementsState).map((n) => `requirement noted: ${n}`),
              ...openJudgmentRequirementNotes(requirementsState).map((n) => `requirement noted: ${n}`),
            ]
          : []),
      ];
      // "Definition of done": a plain-text final answer isn't the actual end
      // of the turn if a verify command is configured — Forge, not the
      // model, is the arbiter of whether the goal is really met. A failing
      // check gets fed straight back in as evidence and the loop continues,
      // which is what makes OUTCOME mode's iterate-until-true promise real.
      const effectiveVerify = resolveVerifyCommandForFinal({
        mode: options.mode,
        verifyBeforeDone: cfg.verifyBeforeDone,
        settingVerifyCommand: cfg.verifyCommand,
        sessionVerifyCommand: options.verifyCommand,
        userMessage,
        workspaceRoot: deps.workspaceRoot.fsPath,
        turnWroteFiles: filesWrittenThisTurn.length > 0,
      });
      let finalDisplayText = displayText.trim();
      if (effectiveVerify) {
        emit({ type: 'status', text: `Verifying: ${truncateOneLine(effectiveVerify, 80)}…`, activity: 'verify' });
        emit({ type: 'verify_start', command: effectiveVerify, draftText: finalDisplayText });
        const verify = await runVerifyCommand(
          effectiveVerify,
          deps.workspaceRoot.fsPath,
          cancellation,
          cfg.verifyTimeoutSec * 1000,
        );
        emit({ type: 'verify_result', command: effectiveVerify, ok: verify.ok, summary: summarize(verify.output) });
        if (cancellation.isCancellationRequested) {
          emit({ type: 'aborted' });
          return { messages, compactionCache };
        }
        if (!verify.ok) {
          const hadProgressSinceLastVerify = writesSinceLastVerify.length > 0;
          const verifyRejectNote =
            '\n\n[System: This completion was not accepted — the definition-of-done check failed. Forge is continuing the turn; do not treat the task as finished yet.]';
          pushAssistant(fullText + verifyRejectNote);
          const nudge = `[Definition-of-done check failed]\n${verify.output}\n\nThe goal is not met yet — this is real evidence, not an opinion. Diagnose why and keep working; do not repeat the same "done" claim without either fixing the underlying issue or explaining concretely why this check itself is wrong (e.g. it tests the wrong thing). Do NOT make this check pass by disabling, skipping, or weakening what it verifies (e.g. skipping/deleting the failing test, neutering an assertion, silencing an error instead of fixing it, or editing the check command itself) — Forge scans for exactly that pattern and will flag it to the user, and it does not actually satisfy the user's goal even if the command exits 0.`;
          pushMsg({ role: 'user', content: nudge });
          sawFailedVerify = true;
          writesSinceLastVerify = [];
          traceIter({ note: 'verify-failed' });
          if (
            checkLoop(loopDetector, '__verify__', { command: effectiveVerify }, false, verify.output, emit, {
              skipWhenWorkspaceProgress: hadProgressSinceLastVerify,
            })
          ) {
            return { messages, compactionCache };
          }
          continue;
        }
        if (sawFailedVerify) {
          const findings = detectSuspiciousVerifyBypass(writesSinceLastVerify, effectiveVerify);
          if (findings.length > 0) emit({ type: 'verify_gaming_warning', findings });
        }
        sawFailedVerify = false;
        writesSinceLastVerify = [];
        finalDisplayText += formatVerifyFinalNote(effectiveVerify, true);
      }

      pushAssistant(fullText);

      traceIter({ final: true });
      pendingActionTarget = undefined;
      emit({
        type: 'final',
        text: finalDisplayText,
        unverifiedClaims: unverifiedAll.length > 0 ? unverifiedAll : undefined,
        verifyCommand: effectiveVerify,
        verifyOk: effectiveVerify ? true : undefined,
      });
      emit({ type: 'done' });
      return { messages, compactionCache };
    }

    // Keep the model's own transcript of what it did, so it has memory of
    // prior tool calls across iterations.
    pushAssistant(
      fullText,
      call && (nativeAcceptedFormat || containsHarmonyControls(fullText)) ? call : undefined,
    );

    if (nativeAcceptedFormat) {
      traceIter({ note: `native-tool-call-accepted:${nativeAcceptedFormat}` });
    }

    if (pendingActionTarget) {
      const pending = pendingActionTarget;
      const bypass = PENDING_ACTION_BYPASS_TOOLS.has(call.tool);
      const matches =
        !bypass && toolCallMatchesPendingPath(call, pending.path, deps.workspaceRoot);
      if (bypass) {
        /* keep pending — reading/searching before finishing the write is fine */
      } else if (matches) {
        pendingActionTarget = undefined;
      } else if (pending.redirectsUsed >= 1) {
        pendingActionTarget = undefined;
      } else {
        pending.redirectsUsed++;
        const redirectMsg = `[System check] Not executed: you still have not finished ${pending.tool} on \`${pending.path}\`. Do that exact action now, before anything else.`;
        pushMsg({ role: 'user', content: redirectMsg });
        traceIter({ note: 'pending-action-redirect', tool: call.tool, path: describeArgsForTrace(call.tool, call.args).path });
        continue;
      }
    }

    // Self-consistency / best-of-N for the single riskiest step in the loop:
    // a full-file rewrite of an existing file (forge.bestOfN.enabled, off by
    // default — see bestOfN.ts for the full rationale and scoring). This can
    // swap `call` (and the just-pushed assistant message) for a
    // better-scoring resampled candidate; it never blocks or retries the
    // turn if resampling itself fails.
    if (
      cfg.bestOfNEnabled &&
      call.tool === 'write_file' &&
      !call.args?.delete &&
      typeof call.args?.content === 'string' &&
      call.args.content.split('\n').length >= MIN_LINES_FOR_BEST_OF_N
    ) {
      const rewritePath: string | undefined = call.args?.path ?? call.args?.file;
      if (rewritePath) {
        try {
          const uri = resolveWorkspacePath(deps.workspaceRoot, rewritePath);
          const existingFileText = await deps.pendingEdits.readEffective(uri);
          if (existingFileText !== undefined) {
            emit({ type: 'status', text: `Sampling ${cfg.bestOfNSamples} candidate rewrites of ${rewritePath} to pick the best…`, activity: 'think' });
            const best = await sampleBestOfNForRewrite({
              ollama: deps.ollama,
              promptView,
              model,
              temperature: cfg.temperature,
              numCtx,
              signal: cancellationToAbortSignal(cancellation),
              samples: cfg.bestOfNSamples,
              firstCandidate: { fullText, call },
              existingFileText,
              expectedPath: rewritePath,
            });
            if (best.call && best.fullText !== fullText) {
              call = best.call;
              fullText = best.fullText;
              messages[messages.length - 1] = { role: 'assistant', content: assistantContentForHistory(best.fullText) };
            }
          }
        } catch (err) {
          logger.warn('best-of-N rewrite sampling failed, using the original candidate', String(err));
        }
      }
    }

    call = unwrapNestedToolCall(call);
    const builtInSpec = TOOL_MAP[call.tool];
    const mcpSpec = builtInSpec ? undefined : mcpToolMap.get(call.tool);
    const resolvedSpec = builtInSpec || mcpSpec;
    const callId = nextCallId();
    const described = describeToolCall(call.tool, call.args);
    emit({ type: 'status', text: described.text, activity: described.activity });
    emit({ type: 'tool_call', tool: call.tool, args: call.args, callId });

    if (!resolvedSpec) {
      const errMsg = `Unknown tool "${call.tool}". Available tools: ${[...Object.keys(TOOL_MAP), ...mcpToolMap.keys()].join(', ')}.`;
      emit({ type: 'tool_result', callId, ok: false, summary: errMsg });
      pushMsg({ role: 'user', content: `[Tool error]\n${errMsg}` });
      traceIter({ tool: call.tool, ok: false, note: 'unknown-or-disallowed-tool' });
      if (checkLoop(loopDetector, call.tool, call.args, false, errMsg, emit)) return { messages, compactionCache };
      continue;
    }

    // MCP tools aren't part of the ToolName-typed allowedTools set (their
    // names are arbitrary, server-defined strings) — gated instead by the
    // same "full read/write/run access" modes write_file/run_command already
    // require, never Ask (read-only) or Plan (no tools at all).
    const modeAllowsThisTool = mcpSpec
      ? options.mode === 'agent' || options.mode === 'auto' || options.mode === 'outcome'
      : allowedTools.has(builtInSpec!.name);
    if (!modeAllowsThisTool) {
      const errMsg = `"${resolvedSpec.name}" is not available in ${options.mode} mode. ${
        options.mode === 'ask' ? 'Ask mode is read-only — tell the user to switch to Agent mode for edits/commands.' : ''
      }`;
      emit({ type: 'tool_result', callId, ok: false, summary: errMsg });
      pushMsg({ role: 'user', content: `[Tool error]\n${errMsg}` });
      traceIter({ tool: call.tool, ok: false, note: 'unknown-or-disallowed-tool' });
      if (checkLoop(loopDetector, call.tool, call.args, false, errMsg, emit)) return { messages, compactionCache };
      continue;
    }

    // Gating hooks for the two built-in side-effecting tools. (MCP tools
    // have their own approval gate inside mcpManager.ts's tool wrapper —
    // reusing the same before-write/before-command hook names for
    // arbitrary third-party MCP tools wouldn't mean anything meaningful.)
    if (resolvedSpec.name === 'write_file' || resolvedSpec.name === 'run_command') {
      const hookEvent = resolvedSpec.name === 'write_file' ? 'before-write' : 'before-command';
      const hookResult = await deps.hooks.run(hookEvent, { tool: call.tool, args: call.args });
      if (hookResult.blocked) {
        const msg = `Blocked by .forge/hooks/${hookEvent}${hookResult.message ? `: ${hookResult.message}` : '.'}`;
        emit({ type: 'tool_result', callId, ok: false, summary: msg });
        pushMsg({ role: 'user', content: `[Tool error]\n${msg}` });
        traceIter({ tool: call.tool, ok: false, note: 'blocked-by-hook' });
        if (checkLoop(loopDetector, call.tool, call.args, false, msg, emit)) return { messages, compactionCache };
        continue;
      }
    }

    const toolStartedAt = Date.now();
    let result;
    try {
      result = await raceToolCallWithCancellation(resolvedSpec.run(call.args, toolCtx), cancellation);
    } catch (err: any) {
      logger.error(`tool ${call.tool} threw`, err);
      result = { ok: false, content: `Tool "${call.tool}" crashed: ${err?.message || err}` };
    }

    // Generic, non-blocking advisory from any tool (see ToolResult.warning's
    // doc comment) — surfaced as its own visible transcript entry, not just
    // left inside the tool's own result content. Checked unconditionally,
    // regardless of which tool ran or whether it succeeded, so it stays a
    // reusable extension point rather than something wired to one tool.
    if (result.warning) {
      emit({ type: 'tool_warning', text: result.warning });
    }

    if (resolvedSpec.name === 'write_file' && result.ok) {
      deps.hooks.run('after-write', { args: call.args }).catch(() => {});
      // Record for gamingDetection.ts below — the text actually being
      // written (full-content or the search/replace pair) is already right
      // here in the call args, no need to re-read the file back off disk.
      const path = typeof call.args?.path === 'string' ? call.args.path : '';
      const text = [call.args?.content, call.args?.search, call.args?.replace].filter((v) => typeof v === 'string').join('\n');
      writesSinceLastVerify.push({ path, text });
      if (path) {
        filesWrittenThisTurn.push(path);
        if (unresolvedRunFailure && !unresolvedRunFailure.filesEditedAfter.includes(path)) {
          unresolvedRunFailure.filesEditedAfter.push(path);
        }
      }
    } else if (resolvedSpec.name === 'run_command') {
      const cmd = typeof call.args?.command === 'string' ? call.args.command : '';
      if (cmd) commandsExecutedThisTurn.push(cmd);
      if (result.ok) {
        unresolvedRunFailure = undefined;
        deps.hooks.run('after-command', { args: call.args }).catch(() => {});
      } else if (cmd) {
        unresolvedRunFailure = {
          command: cmd,
          exitCode: parseRunCommandExitCode(result.content),
          filesEditedAfter: [],
          outputSnippet: result.content.split(/\r?\n/).slice(0, 2).join('\n').trim().slice(0, 300),
        };
      }
    }

    // Optional self-critique pass (forge.selfCritique.enabled, off by
    // default) — one extra, tightly-scoped model call asking "does this
    // look right," folded into the SAME tool result the model reacts to
    // next, so a caught mistake can be fixed within this same turn rather
    // than only surfacing later in human review. See selfCritique.ts.
    let critique: string | undefined;
    if (resolvedSpec.name === 'write_file' && result.ok && cfg.selfCritiqueEnabled && shouldCritique(call.args, cfg.selfCritiqueMinLines)) {
      const writtenText = typeof call.args?.content === 'string' ? call.args.content : typeof call.args?.replace === 'string' ? call.args.replace : '';
      const critiquePath = typeof call.args?.path === 'string' ? call.args.path : call.args?.file ?? 'the file';
      emit({ type: 'status', text: `Double-checking the edit to ${critiquePath}…`, activity: 'verify' });
      critique = await critiqueEdit({
        ollama: deps.ollama,
        model,
        path: critiquePath,
        writtenText,
        isFullRewrite: typeof call.args?.content === 'string',
        signal: cancellationToAbortSignal(cancellation),
      });
    }

    // Note: when write_file stages an edit it goes through toolCtx.proposeEdit,
    // which updates PendingEditManager directly — the chat provider listens to
    // PendingEditManager.onDidChange to refresh the review cards, so no extra
    // event is needed here.

    const unknownArgNote = unknownArgNotesForSpec(resolvedSpec, call.args as Record<string, unknown>);
    const contentWithUnknownNote = unknownArgNote
      ? `${unknownArgNote}\n${result.content}`
      : result.content;
    let redundantReadNote: string | undefined;
    const argPathForCoverage: unknown = call.args?.path ?? call.args?.file;
    if (call.tool === 'read_file' && result.ok && typeof argPathForCoverage === 'string') {
      const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
      const { redundant } = readCoverage.note({
        path: argPathForCoverage,
        startLine: num(call.args.start_line),
        endLine: num(call.args.end_line),
      });
      if (redundant) {
        redundantReadNote =
          'Note: you already read these lines earlier in this turn. Use what you have; if you have read enough, write your answer now.';
      }
    } else if (call.tool === 'write_file' && result.ok && typeof argPathForCoverage === 'string') {
      readCoverage.invalidate(argPathForCoverage);
    } else if (call.tool === 'run_command') {
      readCoverage.clear();
    }
    const contentWithRedundantNote = redundantReadNote ? `${contentWithUnknownNote}\n\n${redundantReadNote}` : contentWithUnknownNote;
    const resultContentForModel = critique ? `${contentWithRedundantNote}\n\n[Self-critique] ${critique}` : contentWithRedundantNote;

    emit({
      type: 'tool_result',
      callId,
      ok: result.ok,
      summary: summarize(resultContentForModel),
      // MCP standardization (0.14.0) — see ToolResultAttachment's doc
      // comment: shown on the tool's transcript card, never folded into the
      // summarized text above.
      attachments: result.attachments,
    });

    pushMsg({ role: 'user', content: `[Tool "${call.tool}" result]\n${resultContentForModel}` });

    foreignFormatNudges = 0;
    incompleteActionNudges = 0;

    if (call.tool === 'run_command') failedRunsInARow = result.ok ? 0 : failedRunsInARow + 1;

    // Trace redundant-read flag (coverage updated above when building the tool result).
    try {
      traceIter({
        tool: call.tool,
        argsHash: argsHash(call.args),
        ...describeArgsForTrace(call.tool, call.args),
        ok: result.ok,
        toolMs: Date.now() - toolStartedAt,
        resultChars: result.content.length,
        ...(call.tool === 'read_file' ? { redundantRead: redundantReadNote !== undefined } : {}),
      });
    } catch {
      /* never let tracing break a turn */
    }

    if (
      checkLoop(loopDetector, call.tool, call.args, result.ok, result.content, emit, {
        pushLoopWarning: (msg) => pushMsg({ role: 'user', content: msg }),
        traceNote: (note) => traceIter({ note }),
        unresolvedRunFailure,
      })
    ) {
      return { messages, compactionCache };
    }
  }

  const iterationSetting = autoMode ? 'forge.autoModeMaxIterations' : 'forge.maxAgentIterations';
  emit({
    type: 'error',
    message: `Stopped after ${maxIterations} steps without a final answer (cap: ${iterationSetting}). Raise that setting in the Forge Settings panel or settings.json, then ask me to continue.`,
  });
  emit({ type: 'done' });
  return { messages, compactionCache };
}

/**
 * Item #7: feeds one step's outcome to the loop detector and, if it looks
 * stuck, emits an error + done and reports back to the caller to stop. This
 * is the real safety net now that maxAgentIterations/autoModeMaxIterations
 * are generous-to-effectively-unbounded (see config.ts).
 *
 * Two exceptions, both from the "loop detection toggle" request:
 * - `check_background_command` is NEVER counted, toggle or no toggle —
 *   polling a long-running background process (that's the whole point of
 *   background commands) is *supposed* to look like the same call
 *   repeated, and flagging that as a stuck loop would defeat the feature.
 * - Everything else is skipped entirely when `forge.loopDetection.enabled`
 *   is turned off, for a task where the repetition genuinely is expected
 *   and the user would rather not be interrupted.
 */
export interface CheckLoopHooks {
  pushLoopWarning?: (message: string) => void;
  traceNote?: (note: string) => void;
  unresolvedRunFailure?: UnresolvedRunFailure;
  /** When true, repeated verify with the same output is allowed (workspace changed since last verify). */
  skipWhenWorkspaceProgress?: boolean;
}

export function checkLoop(
  detector: LoopDetector,
  tool: string,
  args: Record<string, any>,
  ok: boolean,
  resultContent: string,
  emit: (event: AgentEvent) => void,
  hooks?: CheckLoopHooks
): boolean {
  if (tool === 'check_background_command') return false;
  if (!getConfig().loopDetectionEnabled) return false;
  if (tool === '__verify__' && hooks?.skipWhenWorkspaceProgress) return false;
  const signature = signatureForStep(tool, args, ok, resultContent);
  const check = detector.record(signature);
  if (!check.looping) return false;
  const occurrences = check.occurrences ?? 0;
  const warnKey = check.warnSignature ?? signature;
  if (!detector.hasWarnedForSignature(warnKey)) {
    detector.markWarnedForSignature(warnKey);
    const warn = formatLoopWarningMessage(
      tool,
      args,
      occurrences,
      resultContent,
      hooks?.unresolvedRunFailure
        ? {
            command: hooks.unresolvedRunFailure.command,
            exitCode: hooks.unresolvedRunFailure.exitCode ?? undefined,
            snippet: hooks.unresolvedRunFailure.outputSnippet,
          }
        : undefined
    );
    hooks?.pushLoopWarning?.(warn);
    hooks?.traceNote?.('loop-warning');
    return false;
  }
  emit({
    type: 'error',
    message: `Forge stopped: possible loop detected. ${check.reason} You can ask me to try a different approach, or continue if this was actually expected. (Loop detection can be turned off in Settings if this keeps happening for legitimately repetitive work.)`,
  });
  emit({ type: 'done' });
  return true;
}

/**
 * Item 5/8's fix ("stop works but freezes the chat, unusable afterward"):
 * even with commandTool.ts's SIGTERM->SIGKILL escalation, some tool call
 * could in principle still never settle (a hung native call, a bug in a
 * less-common tool, a web request whose own timeout hasn't fired yet).
 * Without this, a single stuck `spec.run()` blocks this `await` forever,
 * which blocks `runAgentTurn()` from ever returning, which leaves
 * ChatSession.busy stuck `true` forever — a stop button that "worked" but
 * left the chat permanently unusable, unable to accept new messages.
 *
 * This races the real tool call against "cancellation fired, and it's now
 * been TOOL_ABORT_GRACE_MS since" — if the grace period elapses with no real
 * result, the turn treats it as aborted rather than waiting forever. The
 * real process (if any) is still asked to terminate via `cancellation`
 * itself (see commandTool.ts); this is a backstop for when that doesn't
 * happen fast enough, not a replacement for actually killing it — if the
 * real promise does eventually settle after this fires, it's simply
 * ignored (the `settled` guard below), so nothing double-applies.
 */
export const TOOL_ABORT_GRACE_MS = 4000;
export function raceToolCallWithCancellation(promise: Promise<ToolResult>, cancellation: vscode.CancellationToken): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false;
    let sub: vscode.Disposable | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sub?.dispose();
      fn();
    };
    promise.then(
      (r) => finish(() => resolve(r)),
      (err) => finish(() => reject(err))
    );
    const armGraceTimer = () =>
      setTimeout(() => {
        finish(() =>
          resolve({
            ok: false,
            content: 'Tool call aborted after Stop was requested — the underlying process may still be finishing termination in the background. If this keeps happening for the same tool, please report it.',
          })
        );
      }, TOOL_ABORT_GRACE_MS);
    if (cancellation.isCancellationRequested) {
      armGraceTimer();
    } else {
      sub = cancellation.onCancellationRequested(() => armGraceTimer());
    }
  });
}

function summarize(content: string, maxLen = 220): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

function cancellationToAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
