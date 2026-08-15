import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { ChatMessage } from '../ollama/types';
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
): Promise<ChatMessage[]> {
  const cfg = getConfig();
  const messages: ChatMessage[] = [...history];
  const allowedTools = new Set(toolsAllowedInMode(options.mode));

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
    proposeEdit: async (edit) => deps.pendingEdits.propose(edit, cfg.requireApprovalForWrites),
    readEffective: (uri) => deps.pendingEdits.readEffective(uri),
    requestCommandApproval: (command, callId) => deps.approvalBroker.requestCommandApproval(command, callId),
    codebaseSearch: deps.codebaseSearch,
    config: {
      autoApproveCommands: cfg.autoApproveCommands,
      requireApprovalForWrites: cfg.requireApprovalForWrites,
      requireApprovalForCommands: cfg.requireApprovalForCommands,
      maxContextFileKB: cfg.maxContextFileKB,
    },
  };

  for (let iteration = 0; iteration < cfg.maxAgentIterations; iteration++) {
    if (cancellation.isCancellationRequested) {
      emit({ type: 'aborted' });
      return messages;
    }

    emit({ type: 'thought_start' });
    let fullText = '';
    try {
      fullText = await deps.ollama.chat({
        model,
        messages,
        temperature: cfg.temperature,
        signal: cancellationToAbortSignal(cancellation),
        onToken: (token) => emit({ type: 'token', text: token }),
      });
    } catch (err: any) {
      logger.error('agent chat() failed', err);
      emit({ type: 'error', message: err?.message || String(err) });
      return messages;
    }

    if (cancellation.isCancellationRequested) {
      emit({ type: 'aborted' });
      return messages;
    }

    const call = options.mode === 'plan' ? null : parseToolCall(fullText);

    if (!call) {
      messages.push({ role: 'assistant', content: fullText });
      emit({ type: 'final', text: fullText.trim() });
      emit({ type: 'done' });
      return messages;
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
      continue;
    }

    if (!allowedTools.has(spec.name)) {
      const errMsg = `"${spec.name}" is not available in ${options.mode} mode. ${
        options.mode === 'ask' ? 'Ask mode is read-only — tell the user to switch to Agent mode for edits/commands.' : ''
      }`;
      emit({ type: 'tool_result', callId, ok: false, summary: errMsg });
      messages.push({ role: 'user', content: `[Tool error]\n${errMsg}` });
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
  }

  emit({
    type: 'error',
    message: `Stopped after ${cfg.maxAgentIterations} steps without a final answer. You can ask me to continue.`,
  });
  emit({ type: 'done' });
  return messages;
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
