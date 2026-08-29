import * as vscode from 'vscode';
import { OllamaClient, keepAliveOpt } from '../ollama/client';
import { ChatMessage, OllamaCallMetrics } from '../ollama/types';
import { AgentActivity, AgentEvent, ToolCall, ToolExecContext, ToolResult } from './types';
import { buildSystemPrompt, buildTurnContextPrefix } from './systemPrompt';
import { parseToolCall } from './toolProtocol';
import { parseStructuredResponse, STRUCTURED_RESPONSE_SCHEMA } from './structuredOutput';
import { generatePlanFirst, renderPlanFirstForPrompt } from './planFirst';
import { shouldCritique, critiqueEdit } from './selfCritique';
import { sampleBestOfNForRewrite, MIN_LINES_FOR_BEST_OF_N } from './bestOfN';
import { TOOL_MAP } from '../tools';
import { PendingEditManager } from '../tools/editApply';
import { ApprovalBroker } from './approvalBroker';
import { ForgeMode, isAutonomousMode, toolsAllowedInMode } from './modes';
import { HookRunner } from '../forge/hooks';
import { getConfig } from '../util/config';
import { logger } from '../util/logger';
import { resolveWorkspacePath } from '../util/paths';
import { CompactionCache, hardCapOversizedMessages, maybeCompact, pruneStaleReadsView } from './contextManager';
import { LoopDetector, signatureForStep } from './loopDetector';
import { findUnverifiedClaims } from './claimChecker';
import { runVerifyCommand } from './verifyCheck';
import { detectSuspiciousVerifyBypass } from './gamingDetection';
import { BackgroundProcessManager } from '../tools/backgroundProcessManager';
import { DynamicToolSpec } from '../mcp/mcpTypes';

export interface AgentDeps {
  ollama: OllamaClient;
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
  workspaceRoot: vscode.Uri;
  workspaceName: string;
}

export interface AgentTurnOptions {
  mode: ForgeMode;
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
export function resolveModelResponse(fullText: string, structuredOutputEnabled: boolean): { call: ToolCall | null; displayText: string } {
  if (structuredOutputEnabled) {
    const structured = parseStructuredResponse(fullText);
    if (structured) {
      if (structured.call) return { call: structured.call, displayText: fullText };
      return { call: null, displayText: structured.finalText ?? '' };
    }
  }
  return { call: parseToolCall(fullText), displayText: fullText };
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
  });
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: systemPrompt };
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  const turnContextPrefix = buildTurnContextPrefix({
    memoryText: options.memoryText,
    projectLogText: options.projectLogText,
    milestonesText: options.milestonesText,
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

  messages.push({ role: 'user', content: `${turnContextPrefix}${planBlock}${userMessage}` });

  const toolCtx: ToolExecContext = {
    workspaceRoot: deps.workspaceRoot,
    cancellation,
    proposeEdit: async (edit) => deps.pendingEdits.propose(edit, requireApprovalForWrites),
    readEffective: (uri) => deps.pendingEdits.readEffective(uri),
    requestCommandApproval: (command, callId) => deps.approvalBroker.requestCommandApproval(command, callId),
    codebaseSearch: deps.codebaseSearch,
    rememberFact: deps.rememberFact,
    chatMemorySearch: deps.chatMemorySearch,
    webSearch: deps.webSearch,
    webFetch: deps.webFetch,
    startBackgroundCommand: (command, cwd) => deps.backgroundProcesses.start(command, cwd),
    checkBackgroundCommand: (id) => deps.backgroundProcesses.check(id),
    killBackgroundCommand: (id) => deps.backgroundProcesses.kill(id),
    listBackgroundCommands: () => deps.backgroundProcesses.list(),
    spawnSubAgent: async (task, contextHint) => {
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
      const subUserMessage = contextHint ? `${task}\n\n[Context from parent agent]\n${contextHint}` : task;
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
      return outcome;
    },
    config: {
      autoApproveCommands: cfg.autoApproveCommands,
      requireApprovalForWrites,
      requireApprovalForCommands: autoMode ? false : cfg.requireApprovalForCommands,
      maxContextFileKB: cfg.maxContextFileKB,
    },
  };

  /** Builds the trimmed view actually sent to Ollama — never mutates `messages`, the archival/persisted transcript. See contextManager.ts. */
  async function buildPromptView(): Promise<ChatMessage[]> {
    const pruned = pruneStaleReadsView(messages);
    const compacted = await maybeCompact(pruned, compactionCache, model, numCtx, deps.ollama, cancellationToAbortSignal(cancellation));
    compactionCache = compacted.cache;
    return hardCapOversizedMessages(compacted.promptMessages);
  }

  let hallucinationNudges = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (cancellation.isCancellationRequested) {
      emit({ type: 'aborted' });
      return { messages, compactionCache };
    }

    const promptView = await buildPromptView();

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
        keepAliveMinutes: keepAliveOpt(cfg.keepAliveMinutes),
        format: structuredOutputEnabled ? STRUCTURED_RESPONSE_SCHEMA : undefined,
        onToken: (token) => emit({ type: 'token', text: token }),
        onMetrics: (metrics) => emit({ type: 'metrics', metrics }),
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

    if (!call) {
      // Item #10: catch the model claiming it made a change ("created
      // `foo.ts`") that no write_file call actually backs up, and give it a
      // couple of chances to either actually do it or correct the claim,
      // instead of shipping a confidently wrong final answer.
      const unverified = findUnverifiedClaims(displayText, messages);
      if (unverified.length > 0 && hallucinationNudges < 2) {
        hallucinationNudges++;
        messages.push({ role: 'assistant', content: fullText });
        const nudge = `[System check] You said you changed ${unverified.map((p) => `\`${p}\``).join(', ')}, but no write_file call for ${unverified.length === 1 ? 'that path' : 'those paths'} appears anywhere in this conversation. If you meant to make that change, call write_file now. If it's already done and this check is wrong, just continue — but don't simply repeat the same claim without acting or correcting it.`;
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      messages.push({ role: 'assistant', content: fullText });

      // "Definition of done": a plain-text final answer isn't the actual end
      // of the turn if a verify command is configured — Forge, not the
      // model, is the arbiter of whether the goal is really met. A failing
      // check gets fed straight back in as evidence and the loop continues,
      // which is what makes OUTCOME mode's iterate-until-true promise real.
      if (options.verifyCommand) {
        emit({ type: 'status', text: `Verifying: ${truncateOneLine(options.verifyCommand, 80)}…`, activity: 'verify' });
        emit({ type: 'verify_start', command: options.verifyCommand, draftText: displayText.trim() });
        const verify = await runVerifyCommand(options.verifyCommand, deps.workspaceRoot.fsPath, cancellation);
        emit({ type: 'verify_result', command: options.verifyCommand, ok: verify.ok, summary: summarize(verify.output) });
        if (cancellation.isCancellationRequested) {
          emit({ type: 'aborted' });
          return { messages, compactionCache };
        }
        if (!verify.ok) {
          const nudge = `[Definition-of-done check failed]\n${verify.output}\n\nThe goal is not met yet — this is real evidence, not an opinion. Diagnose why and keep working; do not repeat the same "done" claim without either fixing the underlying issue or explaining concretely why this check itself is wrong (e.g. it tests the wrong thing). Do NOT make this check pass by disabling, skipping, or weakening what it verifies (e.g. skipping/deleting the failing test, neutering an assertion, silencing an error instead of fixing it, or editing the check command itself) — Forge scans for exactly that pattern and will flag it to the user, and it does not actually satisfy the user's goal even if the command exits 0.`;
          messages.push({ role: 'user', content: nudge });
          sawFailedVerify = true;
          writesSinceLastVerify = [];
          if (checkLoop(loopDetector, '__verify__', { command: options.verifyCommand }, false, verify.output, emit)) {
            return { messages, compactionCache };
          }
          continue;
        }
        if (sawFailedVerify) {
          const findings = detectSuspiciousVerifyBypass(writesSinceLastVerify, options.verifyCommand);
          if (findings.length > 0) emit({ type: 'verify_gaming_warning', findings });
        }
        sawFailedVerify = false;
        writesSinceLastVerify = [];
      }

      emit({ type: 'final', text: displayText.trim(), unverifiedClaims: unverified.length > 0 ? unverified : undefined });
      emit({ type: 'done' });
      return { messages, compactionCache };
    }

    // Keep the model's own transcript of what it did, so it has memory of
    // prior tool calls across iterations.
    messages.push({ role: 'assistant', content: fullText });

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
              messages[messages.length - 1] = { role: 'assistant', content: best.fullText };
            }
          }
        } catch (err) {
          logger.warn('best-of-N rewrite sampling failed, using the original candidate', String(err));
        }
      }
    }

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
      messages.push({ role: 'user', content: `[Tool error]\n${errMsg}` });
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
      messages.push({ role: 'user', content: `[Tool error]\n${errMsg}` });
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
        messages.push({ role: 'user', content: `[Tool error]\n${msg}` });
        if (checkLoop(loopDetector, call.tool, call.args, false, msg, emit)) return { messages, compactionCache };
        continue;
      }
    }

    let result;
    try {
      result = await raceToolCallWithCancellation(resolvedSpec.run(call.args, toolCtx), cancellation);
    } catch (err: any) {
      logger.error(`tool ${call.tool} threw`, err);
      result = { ok: false, content: `Tool "${call.tool}" crashed: ${err?.message || err}` };
    }

    if (resolvedSpec.name === 'write_file' && result.ok) {
      deps.hooks.run('after-write', { args: call.args }).catch(() => {});
      // Record for gamingDetection.ts below — the text actually being
      // written (full-content or the search/replace pair) is already right
      // here in the call args, no need to re-read the file back off disk.
      const path = typeof call.args?.path === 'string' ? call.args.path : '';
      const text = [call.args?.content, call.args?.search, call.args?.replace].filter((v) => typeof v === 'string').join('\n');
      writesSinceLastVerify.push({ path, text });
    } else if (resolvedSpec.name === 'run_command' && result.ok) {
      deps.hooks.run('after-command', { args: call.args }).catch(() => {});
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

    const resultContentForModel = critique ? `${result.content}\n\n[Self-critique] ${critique}` : result.content;

    emit({
      type: 'tool_result',
      callId,
      ok: result.ok,
      summary: summarize(resultContentForModel),
    });

    messages.push({ role: 'user', content: `[Tool "${call.tool}" result]\n${resultContentForModel}` });

    if (checkLoop(loopDetector, call.tool, call.args, result.ok, result.content, emit)) {
      return { messages, compactionCache };
    }
  }

  emit({
    type: 'error',
    message: `Stopped after ${maxIterations} steps without a final answer. You can ask me to continue.`,
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
export function checkLoop(
  detector: LoopDetector,
  tool: string,
  args: Record<string, any>,
  ok: boolean,
  resultContent: string,
  emit: (event: AgentEvent) => void
): boolean {
  if (tool === 'check_background_command') return false;
  if (!getConfig().loopDetectionEnabled) return false;
  const check = detector.record(signatureForStep(tool, args, ok, resultContent));
  if (!check.looping) return false;
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
