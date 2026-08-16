import * as vscode from 'vscode';
import { OllamaClient, keepAliveOpt } from '../ollama/client';
import { ChatMessage, OllamaCallMetrics } from '../ollama/types';
import { AgentEvent, ToolExecContext } from './types';
import { buildSystemPrompt } from './systemPrompt';
import { parseToolCall } from './toolProtocol';
import { TOOL_MAP } from '../tools';
import { PendingEditManager } from '../tools/editApply';
import { ApprovalBroker } from './approvalBroker';
import { ForgeMode, toolsAllowedInMode } from './modes';
import { HookRunner } from '../forge/hooks';
import { getConfig } from '../util/config';
import { logger } from '../util/logger';
import { CompactionCache, hardCapOversizedMessages, maybeCompact, pruneStaleReadsView } from './contextManager';
import { LoopDetector, signatureForStep } from './loopDetector';
import { findUnverifiedClaims } from './claimChecker';

export interface AgentDeps {
  ollama: OllamaClient;
  pendingEdits: PendingEditManager;
  approvalBroker: ApprovalBroker;
  hooks: HookRunner;
  codebaseSearch: (query: string, k: number) => Promise<{ path: string; snippet: string; score: number }[]>;
  workspaceRoot: vscode.Uri;
  workspaceName: string;
}

export interface AgentTurnOptions {
  mode: ForgeMode;
  rulesText?: string;
  planContext?: string;
  /** Carried across turns so compaction doesn't re-summarize from scratch every time — see ChatSession. */
  compactionCache?: CompactionCache;
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
  const autoMode = options.mode === 'auto';
  // Auto mode is fully autonomous (item #2): no approval gate for writes.
  // Command approval is handled by ApprovalBroker itself (ChatSession wires
  // its getRequireApproval() to be mode-aware) — the dangerous-command
  // denylist in commandTool.ts still applies there regardless of mode.
  const requireApprovalForWrites = autoMode ? false : cfg.requireApprovalForWrites;
  const maxIterations = autoMode ? cfg.autoModeMaxIterations : cfg.maxAgentIterations;

  const messages: ChatMessage[] = [...history];
  const allowedTools = new Set(toolsAllowedInMode(options.mode));
  const loopDetector = new LoopDetector();
  let compactionCache = options.compactionCache;

  // Mode/rules can change between turns (user flips the mode dropdown, edits
  // a rule file, etc.) — always refresh the system prompt rather than trusting
  // whatever was pinned as messages[0] from a previous turn.
  const systemPrompt = buildSystemPrompt(deps.workspaceName, options.mode, {
    rulesText: options.rulesText,
    planContext: options.planContext,
  });
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: systemPrompt };
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const toolCtx: ToolExecContext = {
    workspaceRoot: deps.workspaceRoot,
    cancellation,
    proposeEdit: async (edit) => deps.pendingEdits.propose(edit, requireApprovalForWrites),
    readEffective: (uri) => deps.pendingEdits.readEffective(uri),
    requestCommandApproval: (command, callId) => deps.approvalBroker.requestCommandApproval(command, callId),
    codebaseSearch: deps.codebaseSearch,
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
    const compacted = await maybeCompact(pruned, compactionCache, model, cfg.numCtx, deps.ollama, cancellationToAbortSignal(cancellation));
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
    let fullText = '';
    try {
      fullText = await deps.ollama.chat({
        model,
        messages: promptView,
        temperature: cfg.temperature,
        signal: cancellationToAbortSignal(cancellation),
        numCtx: cfg.numCtx,
        keepAliveMinutes: keepAliveOpt(cfg.keepAliveMinutes),
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

    const call = options.mode === 'plan' ? null : parseToolCall(fullText);

    if (!call) {
      // Item #10: catch the model claiming it made a change ("created
      // `foo.ts`") that no write_file call actually backs up, and give it a
      // couple of chances to either actually do it or correct the claim,
      // instead of shipping a confidently wrong final answer.
      const unverified = findUnverifiedClaims(fullText, messages);
      if (unverified.length > 0 && hallucinationNudges < 2) {
        hallucinationNudges++;
        messages.push({ role: 'assistant', content: fullText });
        const nudge = `[System check] You said you changed ${unverified.map((p) => `\`${p}\``).join(', ')}, but no write_file call for ${unverified.length === 1 ? 'that path' : 'those paths'} appears anywhere in this conversation. If you meant to make that change, call write_file now. If it's already done and this check is wrong, just continue — but don't simply repeat the same claim without acting or correcting it.`;
        messages.push({ role: 'user', content: nudge });
        continue;
      }
      messages.push({ role: 'assistant', content: fullText });
      emit({ type: 'final', text: fullText.trim(), unverifiedClaims: unverified.length > 0 ? unverified : undefined });
      emit({ type: 'done' });
      return { messages, compactionCache };
    }

    // Keep the model's own transcript of what it did, so it has memory of
    // prior tool calls across iterations.
    messages.push({ role: 'assistant', content: fullText });

    const spec = TOOL_MAP[call.tool];
    const callId = nextCallId();
    emit({ type: 'tool_call', tool: call.tool, args: call.args, callId });

    if (!spec) {
      const errMsg = `Unknown tool "${call.tool}". Available tools: ${Object.keys(TOOL_MAP).join(', ')}.`;
      emit({ type: 'tool_result', callId, ok: false, summary: errMsg });
      messages.push({ role: 'user', content: `[Tool error]\n${errMsg}` });
      if (checkLoop(loopDetector, call.tool, call.args, false, errMsg, emit)) return { messages, compactionCache };
      continue;
    }

    if (!allowedTools.has(spec.name)) {
      const errMsg = `"${spec.name}" is not available in ${options.mode} mode. ${
        options.mode === 'ask' ? 'Ask mode is read-only — tell the user to switch to Agent mode for edits/commands.' : ''
      }`;
      emit({ type: 'tool_result', callId, ok: false, summary: errMsg });
      messages.push({ role: 'user', content: `[Tool error]\n${errMsg}` });
      if (checkLoop(loopDetector, call.tool, call.args, false, errMsg, emit)) return { messages, compactionCache };
      continue;
    }

    // Gating hooks for the two side-effecting tools.
    if (spec.name === 'write_file' || spec.name === 'run_command') {
      const hookEvent = spec.name === 'write_file' ? 'before-write' : 'before-command';
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
      result = await spec.run(call.args, toolCtx);
    } catch (err: any) {
      logger.error(`tool ${call.tool} threw`, err);
      result = { ok: false, content: `Tool "${call.tool}" crashed: ${err?.message || err}` };
    }

    if (spec.name === 'write_file' && result.ok) {
      deps.hooks.run('after-write', { args: call.args }).catch(() => {});
    } else if (spec.name === 'run_command' && result.ok) {
      deps.hooks.run('after-command', { args: call.args }).catch(() => {});
    }

    // Note: when write_file stages an edit it goes through toolCtx.proposeEdit,
    // which updates PendingEditManager directly — the chat provider listens to
    // PendingEditManager.onDidChange to refresh the review cards, so no extra
    // event is needed here.

    emit({
      type: 'tool_result',
      callId,
      ok: result.ok,
      summary: summarize(result.content),
    });

    messages.push({ role: 'user', content: `[Tool "${call.tool}" result]\n${result.content}` });

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

/** Item #7: feeds one step's outcome to the loop detector and, if it looks stuck, emits an error + done and reports back to the caller to stop. This is the real safety net now that maxAgentIterations/autoModeMaxIterations are generous-to-effectively-unbounded (see config.ts). */
function checkLoop(
  detector: LoopDetector,
  tool: string,
  args: Record<string, any>,
  ok: boolean,
  resultContent: string,
  emit: (event: AgentEvent) => void
): boolean {
  const check = detector.record(signatureForStep(tool, args, ok, resultContent));
  if (!check.looping) return false;
  emit({
    type: 'error',
    message: `Forge stopped: possible loop detected. ${check.reason} You can ask me to try a different approach, or continue if this was actually expected.`,
  });
  emit({ type: 'done' });
  return true;
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
