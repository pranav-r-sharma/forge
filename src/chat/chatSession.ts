import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { ChatMessage } from '../ollama/types';
import { PendingEditManager } from '../tools/editApply';
import { ApprovalBroker } from '../agent/approvalBroker';
import { runAgentTurn } from '../agent/agentLoop';
import { AgentEvent } from '../agent/types';
import { ForgeMode } from '../agent/modes';
import { WorkspaceIndex } from '../indexing/workspaceIndex';
import { RulesEngine } from '../forge/rules';
import { SkillsEngine } from '../forge/skills';
import { HookRunner } from '../forge/hooks';
import { ChatStore, StoredSession, deriveTitle } from '../forge/chatStore';
import { getConfig } from '../util/config';
import { genId } from '../util/ids';
import { toRelative } from '../util/paths';
import { logger } from '../util/logger';
import { ExtensionToWebviewMessage, SessionState, UiTranscriptEntry } from '../webview/protocol';

export interface ChatSessionServices {
  ollama: OllamaClient;
  pendingEdits: PendingEditManager;
  workspaceIndex: WorkspaceIndex;
  rules: RulesEngine;
  skills: SkillsEngine;
  hooks: HookRunner;
  chatStore: ChatStore;
  workspaceRoot: vscode.Uri;
  workspaceName: string;
}

/**
 * One agent conversation. Forge supports several of these open at once
 * ("multitask" — see CURSOR_PARITY.md); each owns its own history, mode,
 * model override, and in-flight request, while sharing the workspace-wide
 * services (Ollama client, pending edits, index, rules/skills/hooks).
 *
 * `notify` is called for every UI-relevant event regardless of whether this
 * session is the one currently shown in the webview — the owning
 * ChatViewProvider decides whether to forward the message to the DOM or just
 * update a background "still working" indicator.
 */
export class ChatSession {
  readonly id: string;
  title: string;
  mode: ForgeMode = 'agent';
  model = ''; // '' = use the global default chat model
  uiHistory: UiTranscriptEntry[] = [];
  modelHistory: ChatMessage[] = [];
  busy = false;
  private createdAt: string;

  private cts: vscode.CancellationTokenSource | undefined;
  private approvalBroker: ApprovalBroker;
  private lastPlan: { entryId: string; text: string } | undefined;
  private currentAssistantId: string | undefined;
  private streamMode = new Map<string, 'pending' | 'live' | 'suppressed'>();
  private peek = new Map<string, string>();
  private postedLive = new Set<string>();
  private tokenBuffer = new Map<string, string>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private services: ChatSessionServices,
    private notify: (sessionId: string, msg: ExtensionToWebviewMessage) => void,
    id?: string
  ) {
    this.id = id || services.chatStore.newId();
    this.title = 'New chat';
    this.createdAt = nowIso();
    this.approvalBroker = new ApprovalBroker(
      (e) => this.handleAgentEvent(e),
      () => getConfig().autoApproveCommands,
      () => getConfig().requireApprovalForCommands
    );
  }

  static fromStored(stored: StoredSession, services: ChatSessionServices, notify: (id: string, msg: ExtensionToWebviewMessage) => void): ChatSession {
    const s = new ChatSession(services, notify, stored.id);
    s.title = stored.title;
    s.mode = stored.mode;
    s.model = stored.model;
    s.uiHistory = stored.uiHistory;
    s.modelHistory = stored.modelHistory;
    s.createdAt = stored.createdAt || nowIso();
    return s;
  }

  toStored(): StoredSession {
    return {
      id: this.id,
      title: this.title,
      mode: this.mode,
      model: this.model,
      createdAt: this.createdAt,
      updatedAt: nowIso(),
      uiHistory: this.uiHistory,
      modelHistory: this.modelHistory,
    };
  }

  toSummaryState(): SessionState {
    return { id: this.id, title: this.title, mode: this.mode, model: this.model, busy: this.busy, history: this.uiHistory };
  }

  private persist() {
    this.services.chatStore.save(this.toStored()).catch((err) => logger.warn('session persist failed', String(err)));
  }

  setMode(mode: ForgeMode) {
    this.mode = mode;
    this.persist();
  }

  private post(msg: ExtensionToWebviewMessage) {
    this.notify(this.id, msg);
  }

  private pushEntry(entry: UiTranscriptEntry, alreadyExists = false) {
    if (!alreadyExists) this.uiHistory.push(entry);
    else {
      const idx = this.uiHistory.findIndex((e) => e.id === entry.id);
      if (idx >= 0) this.uiHistory[idx] = entry;
      else this.uiHistory.push(entry);
    }
    if (this.uiHistory.length > 400) this.uiHistory = this.uiHistory.slice(-400);
    this.persist();
  }

  async runHookOnce(event: 'session-start') {
    await this.services.hooks.run(event, { sessionId: this.id });
  }

  async handleQueryFiles(query: string): Promise<string[]> {
    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target,.forge}/**',
      5000
    );
    const q = query.toLowerCase();
    return files
      .map((u) => toRelative(this.services.workspaceRoot, u))
      .filter((p) => (q ? p.toLowerCase().includes(q) : true))
      .slice(0, 30);
  }

  stop() {
    this.cts?.cancel();
    this.approvalBroker.cancelAll();
  }

  resolveApproval(callId: string, approved: boolean) {
    this.approvalBroker.resolve(callId, approved);
    const idx = this.uiHistory.findIndex((e) => e.kind === 'approval' && e.callId === callId);
    if (idx >= 0) {
      const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'approval' }>;
      entry.status = approved ? 'approved' : 'denied';
      this.pushEntry(entry, true);
      this.post({ type: 'entryUpdate', sessionId: this.id, entry });
    }
  }

  /** Approves a previously-drafted plan and hands off execution to Agent mode. */
  async executePlan(planEntryId: string) {
    if (!this.lastPlan || this.lastPlan.entryId !== planEntryId || this.busy) return;
    const idx = this.uiHistory.findIndex((e) => e.id === planEntryId);
    if (idx >= 0) {
      const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'plan' }>;
      entry.executed = true;
      this.pushEntry(entry, true);
      this.post({ type: 'entryUpdate', sessionId: this.id, entry });
    }
    const plan = this.lastPlan.text;
    this.lastPlan = undefined;
    this.mode = 'agent';
    this.persist();
    await this.send('Execute the approved plan above, step by step.', [], { planContext: plan });
  }

  async send(text: string, files: string[], opts?: { planContext?: string }) {
    if (this.busy) {
      this.post({ type: 'toast', level: 'warn', text: 'This chat is still working — stop it first, or switch to another tab.' });
      return;
    }
    const cfg = getConfig();
    const model = this.model || cfg.chatModel;
    if (!model) {
      this.post({ type: 'toast', level: 'error', text: 'No chat model selected. Click the model name to pick one.' });
      return;
    }
    const health = await this.services.ollama.health();
    if (!health.ok) {
      this.post({ type: 'toast', level: 'error', text: `Can't reach Ollama (${health.error}). Run "ollama serve" and try again.` });
      return;
    }

    // Slash-command skill expansion (Cursor custom-commands equivalent).
    let effectiveText = text;
    let skillUsed: string | undefined;
    if (text.trim().startsWith('/')) {
      const expansion = await this.services.skills.expand(text);
      if (expansion) {
        effectiveText = expansion.expanded;
        skillUsed = expansion.skillUsed;
      }
    }

    if (this.uiHistory.length === 0) this.title = deriveTitle(text);

    const userEntry: UiTranscriptEntry = { kind: 'user', id: genId('u'), text, files };
    this.pushEntry(userEntry);
    this.post({ type: 'entry', sessionId: this.id, entry: userEntry });
    if (skillUsed) {
      const sysEntry: UiTranscriptEntry = { kind: 'system', id: genId('sys'), text: `Expanded /${skillUsed}` };
      this.pushEntry(sysEntry);
      this.post({ type: 'entry', sessionId: this.id, entry: sysEntry });
    }

    let augmented = effectiveText;
    for (const rel of files) {
      try {
        const uri = vscode.Uri.joinPath(this.services.workspaceRoot, rel);
        const content = await this.services.pendingEdits.readEffective(uri);
        if (content !== undefined) {
          const capped = content.length > 20000 ? content.slice(0, 20000) + '\n... (truncated)' : content;
          augmented += `\n\n[Attached file: ${rel}]\n\`\`\`\n${capped}\n\`\`\``;
        }
      } catch {
        /* ignore unreadable attachment */
      }
    }

    const activeFileRel = vscode.window.activeTextEditor
      ? toRelative(this.services.workspaceRoot, vscode.window.activeTextEditor.document.uri)
      : undefined;
    const rulesText = await this.services.rules.renderForPrompt(activeFileRel);

    this.busy = true;
    this.post({ type: 'busy', sessionId: this.id, busy: true });
    this.cts = new vscode.CancellationTokenSource();
    this.startFlushTimer();

    try {
      this.modelHistory = await runAgentTurn(
        this.modelHistory,
        augmented,
        {
          ollama: this.services.ollama,
          pendingEdits: this.services.pendingEdits,
          approvalBroker: this.approvalBroker,
          hooks: this.services.hooks,
          codebaseSearch: (q, k) => this.services.workspaceIndex.search(q, k),
          workspaceRoot: this.services.workspaceRoot,
          workspaceName: this.services.workspaceName,
        },
        (event) => this.handleAgentEvent(event),
        this.cts.token,
        model,
        { mode: this.mode, rulesText: rulesText || undefined, planContext: opts?.planContext }
      );
    } catch (err: any) {
      logger.error('runAgentTurn crashed', err);
      const errEntry: UiTranscriptEntry = { kind: 'error', id: genId('e'), text: err?.message || String(err) };
      this.pushEntry(errEntry);
      this.post({ type: 'entry', sessionId: this.id, entry: errEntry });
    } finally {
      this.stopFlushTimer();
      this.busy = false;
      this.cts = undefined;
      this.post({ type: 'busy', sessionId: this.id, busy: false });
      this.persist();
    }
  }

  private handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case 'thought_start': {
        const id = genId('a');
        this.currentAssistantId = id;
        this.streamMode.set(id, 'pending');
        this.peek.set(id, '');
        const entry: UiTranscriptEntry = { kind: 'assistant', id, text: '', streaming: true };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        return;
      }
      case 'token': {
        const id = this.currentAssistantId;
        if (!id) return;
        const buffered = (this.tokenBuffer.get(id) || '') + event.text;
        this.tokenBuffer.set(id, buffered);
        if (this.streamMode.get(id) === 'pending') {
          const p = (this.peek.get(id) || '') + event.text;
          this.peek.set(id, p);
          if (p.length >= 6 || p.includes('\n')) {
            this.streamMode.set(id, p.trimStart().startsWith('```') ? 'suppressed' : 'live');
          }
        }
        return;
      }
      case 'tool_call': {
        this.flush();
        this.finalizeStreamingAssistant('', true);
        const entry: UiTranscriptEntry = { kind: 'tool', id: genId('t'), callId: event.callId, tool: event.tool, args: event.args, status: 'running' };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        return;
      }
      case 'tool_result': {
        const idx = this.uiHistory.findIndex((e) => e.kind === 'tool' && e.callId === event.callId);
        if (idx >= 0) {
          const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'tool' }>;
          entry.status = 'done';
          entry.ok = event.ok;
          entry.summary = event.summary;
          this.pushEntry(entry, true);
          this.post({ type: 'entryUpdate', sessionId: this.id, entry });
        }
        return;
      }
      case 'approval_request': {
        this.flush();
        const entry: UiTranscriptEntry = { kind: 'approval', id: genId('ap'), callId: event.callId, detail: event.detail, status: 'pending' };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        return;
      }
      case 'pending_edit':
        return; // PendingEditManager.onDidChange is the source of truth, pushed workspace-wide.
      case 'final': {
        this.flush();
        if (this.mode === 'plan') {
          this.finalizeStreamingAssistant('', true); // drop the plain assistant bubble, we render a 'plan' card instead
          const id = genId('plan');
          const entry: UiTranscriptEntry = { kind: 'plan', id, text: event.text, executed: false };
          this.lastPlan = { entryId: id, text: event.text };
          this.pushEntry(entry);
          this.post({ type: 'entry', sessionId: this.id, entry });
        } else {
          this.finalizeStreamingAssistant(event.text);
        }
        return;
      }
      case 'error': {
        this.flush();
        this.finalizeStreamingAssistant('', true);
        const entry: UiTranscriptEntry = { kind: 'error', id: genId('e'), text: event.message };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        return;
      }
      case 'aborted':
        this.flush();
        this.finalizeStreamingAssistant('(stopped)');
        return;
      case 'done':
        this.currentAssistantId = undefined;
        return;
    }
  }

  private finalizeStreamingAssistant(fallbackText: string, forceDrop = false) {
    const id = this.currentAssistantId;
    if (!id) return;
    const idx = this.uiHistory.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'assistant' }>;
      const finalText = fallbackText || (forceDrop ? '' : entry.text);
      if (forceDrop || !finalText.trim()) {
        this.uiHistory.splice(idx, 1);
        this.persist();
        if (this.postedLive.has(id)) {
          this.post({ type: 'entryUpdate', sessionId: this.id, entry: { ...entry, text: '', streaming: false } });
        }
      } else {
        entry.text = finalText;
        entry.streaming = false;
        this.pushEntry(entry, true);
        this.post({ type: 'entryUpdate', sessionId: this.id, entry });
      }
    }
    this.streamMode.delete(id);
    this.peek.delete(id);
    this.postedLive.delete(id);
    this.currentAssistantId = undefined;
  }

  private startFlushTimer() {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => this.flush(), 40);
  }

  private stopFlushTimer() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();
  }

  private flush() {
    for (const [id, delta] of this.tokenBuffer.entries()) {
      if (!delta) continue;
      const idx = this.uiHistory.findIndex((e) => e.id === id);
      const entry = idx >= 0 ? (this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'assistant' }>) : undefined;
      if (entry) entry.text += delta;

      const mode = this.streamMode.get(id) ?? 'live';
      if (mode === 'live') {
        if (!this.postedLive.has(id)) {
          this.post({ type: 'tokenAppend', sessionId: this.id, id, text: entry?.text ?? delta });
          this.postedLive.add(id);
        } else {
          this.post({ type: 'tokenAppend', sessionId: this.id, id, text: delta });
        }
      }
    }
    this.tokenBuffer.clear();
  }
}

function nowIso(): string {
  // Date.now()/new Date() are fine at runtime in the extension host (unlike
  // inside Workflow scripts); this helper just centralizes the format.
  return new Date().toISOString();
}
