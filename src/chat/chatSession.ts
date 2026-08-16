import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { ChatMessage } from '../ollama/types';
import { PendingEditManager } from '../tools/editApply';
import { ApprovalBroker } from '../agent/approvalBroker';
import { runAgentTurn } from '../agent/agentLoop';
import { AgentEvent } from '../agent/types';
import { ForgeMode } from '../agent/modes';
import { CheckpointStore } from '../agent/checkpoints';
import { CompactionCache } from '../agent/contextManager';
import { WorkspaceIndex } from '../indexing/workspaceIndex';
import { ChatMemoryIndex } from '../indexing/chatMemoryIndex';
import { RulesEngine } from '../forge/rules';
import { SkillsEngine } from '../forge/skills';
import { HookRunner } from '../forge/hooks';
import { MemoryStore } from '../forge/memory';
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
  chatMemoryIndex: ChatMemoryIndex;
  rules: RulesEngine;
  skills: SkillsEngine;
  hooks: HookRunner;
  memory: MemoryStore;
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
  private checkpoints = new CheckpointStore();
  private compactionCache: CompactionCache | undefined;
  private beforeWriteSub: vscode.Disposable;

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
      // Auto mode is fully autonomous (item #2) — no command approval gate,
      // except the hard-coded dangerous-command denylist ApprovalBroker
      // itself always enforces regardless of this flag.
      () => (this.mode === 'auto' ? false : getConfig().requireApprovalForCommands)
    );
    // Item #3: lazily capture each touched file's pre-write content so a
    // checkpoint can be restored later. Registered per-session (not
    // workspace-global) even though PendingEditManager is shared across
    // multitask tabs — see checkpoints.ts's doc comment for the known
    // limitation this implies when two tabs edit the same file.
    this.beforeWriteSub = this.services.pendingEdits.onBeforeWrite((relPath, priorContent) => {
      this.checkpoints.recordBeforeWrite(relPath, priorContent);
    });
  }

  static fromStored(stored: StoredSession, services: ChatSessionServices, notify: (id: string, msg: ExtensionToWebviewMessage) => void): ChatSession {
    const s = new ChatSession(services, notify, stored.id);
    s.title = stored.title;
    s.mode = stored.mode;
    s.model = stored.model;
    s.uiHistory = stored.uiHistory;
    s.modelHistory = stored.modelHistory;
    s.createdAt = stored.createdAt || nowIso();
    if (stored.checkpoints) s.checkpoints = CheckpointStore.fromJSON(stored.checkpoints);
    s.compactionCache = stored.compactionCache;
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
      checkpoints: this.checkpoints.toJSON(),
      compactionCache: this.compactionCache,
    };
  }

  toSummaryState(): SessionState {
    return {
      id: this.id,
      title: this.title,
      mode: this.mode,
      model: this.model,
      busy: this.busy,
      history: this.uiHistory,
      checkpoints: this.checkpoints.list().map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt })),
    };
  }

  /** Releases the shared PendingEditManager subscription. Call this whenever a session is removed from ChatViewProvider's in-memory map (closed/deleted), so closing many tabs over a long-running VS Code session doesn't accumulate dead listeners on the workspace-wide PendingEditManager. */
  dispose() {
    this.beforeWriteSub.dispose();
  }

  private persist() {
    this.services.chatStore.save(this.toStored()).catch((err) => logger.warn('session persist failed', String(err)));
  }

  private log(kind: 'user' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'checkpoint' | 'mode_change', detail: string) {
    this.services.chatStore.appendLog(this.id, { ts: nowIso(), kind, detail }).catch(() => {});
  }

  setMode(mode: ForgeMode) {
    this.mode = mode;
    this.log('mode_change', mode);
    this.persist();
  }

  /** Item #3: restores this session's files and transcript to the state at the start of an earlier turn, undoing every edit made from that point on. */
  async restoreCheckpoint(id: string): Promise<{ ok: boolean; message: string }> {
    if (this.busy) return { ok: false, message: 'Stop the current run before restoring a checkpoint.' };
    const resolved = this.checkpoints.applyRestore(id);
    if (!resolved) return { ok: false, message: 'That checkpoint no longer exists.' };

    let filesTouched = 0;
    for (const [relPath, content] of Object.entries(resolved.fileStates)) {
      try {
        const uri = vscode.Uri.joinPath(this.services.workspaceRoot, relPath);
        if (content === null) {
          try {
            await vscode.workspace.fs.delete(uri);
          } catch {
            /* already gone, fine — it didn't exist at the checkpoint either */
          }
        } else {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        }
        filesTouched++;
      } catch (err) {
        logger.warn('checkpoint restore failed for', relPath, String(err));
      }
    }

    this.uiHistory = this.uiHistory.slice(0, resolved.target.uiHistoryIndex);
    this.modelHistory = this.modelHistory.slice(0, resolved.target.modelHistoryLength);
    this.lastPlan = undefined;
    this.log('checkpoint', `restored to ${resolved.target.id} (${resolved.target.label}); reverted ${filesTouched} file(s)`);
    this.persist();
    return { ok: true, message: `Restored to "${resolved.target.label}" — reverted ${filesTouched} file(s) and the conversation from that point on.` };
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

    // Item #3: a checkpoint begins with every turn — nothing is snapshotted
    // yet (see checkpoints.ts), just a marker that "before this point"
    // begins here, so any files touched from here on can be reverted later
    // via restoreCheckpoint(). autoModeSelected reflects the mode this
    // *specific* turn will run in, so a checkpoint label is accurate even if
    // the user flips modes right after sending.
    const checkpointId = genId('ckpt');
    this.checkpoints.begin({
      id: checkpointId,
      label: deriveTitle(text),
      createdAt: nowIso(),
      uiHistoryIndex: this.uiHistory.length,
      modelHistoryLength: this.modelHistory.length,
    });

    const userEntry: UiTranscriptEntry = { kind: 'user', id: genId('u'), text, files, checkpointId };
    this.pushEntry(userEntry);
    this.post({ type: 'entry', sessionId: this.id, entry: userEntry });
    this.log('user', text.length > 300 ? text.slice(0, 300) + '…' : text);
    if (skillUsed) {
      const sysEntry: UiTranscriptEntry = { kind: 'system', id: genId('sys'), text: `Expanded /${skillUsed}` };
      this.pushEntry(sysEntry);
      this.post({ type: 'entry', sessionId: this.id, entry: sysEntry });
    }

    let augmented = effectiveText;
    for (const rel of files) {
      try {
        const uri = vscode.Uri.joinPath(this.services.workspaceRoot, rel);
        const stat = await vscode.workspace.fs.stat(uri).catch(() => undefined);
        if (stat && stat.type === vscode.FileType.Directory) {
          // Item #5: folders can be @-tagged too. We don't dump a whole
          // folder's contents into context (could be huge/binary-laden) —
          // give the model a shallow listing and let it list_dir/read_file
          // its way in from there, same as if it discovered the folder itself.
          const children: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(uri).catch(() => []);
          const names = children.slice(0, 200).map(([name, type]: [string, vscode.FileType]) => `${name}${type === vscode.FileType.Directory ? '/' : ''}`).join('\n');
          augmented += `\n\n[Attached folder: ${rel}]\n${names || '(empty)'}${children.length > 200 ? '\n... (truncated; use list_dir for more)' : ''}`;
          continue;
        }
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
    const memoryText = await this.services.memory.renderForPrompt();

    this.busy = true;
    this.post({ type: 'busy', sessionId: this.id, busy: true });
    this.cts = new vscode.CancellationTokenSource();
    this.startFlushTimer();

    try {
      const result = await runAgentTurn(
        this.modelHistory,
        augmented,
        {
          ollama: this.services.ollama,
          pendingEdits: this.services.pendingEdits,
          approvalBroker: this.approvalBroker,
          hooks: this.services.hooks,
          codebaseSearch: (q, k) => this.services.workspaceIndex.search(q, k),
          rememberFact: (fact) => this.services.memory.addFact(fact),
          chatMemorySearch: (q, k) => this.services.chatMemoryIndex.search(q, k),
          workspaceRoot: this.services.workspaceRoot,
          workspaceName: this.services.workspaceName,
        },
        (event) => this.handleAgentEvent(event),
        this.cts.token,
        model,
        { mode: this.mode, rulesText: rulesText || undefined, memoryText: memoryText || undefined, planContext: opts?.planContext, compactionCache: this.compactionCache }
      );
      this.modelHistory = result.messages;
      this.compactionCache = result.compactionCache;
    } catch (err: any) {
      logger.error('runAgentTurn crashed', err);
      const errEntry: UiTranscriptEntry = { kind: 'error', id: genId('e'), text: err?.message || String(err) };
      this.pushEntry(errEntry);
      this.post({ type: 'entry', sessionId: this.id, entry: errEntry });
      this.log('error', err?.message || String(err));
    } finally {
      this.stopFlushTimer();
      this.busy = false;
      this.cts = undefined;
      this.post({ type: 'busy', sessionId: this.id, busy: false });
      this.persist();
      // Keep search_chat_history current — incremental (see ChatMemoryIndex),
      // so this is cheap on every turn except when this session actually
      // grew. Best-effort: a memory-index failure must never break the turn
      // that just completed.
      this.services.chatMemoryIndex.indexSession(this.toStored()).catch((err) => logger.warn('chat memory indexing failed', String(err)));
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
        this.log('tool_call', `${event.tool} ${JSON.stringify(event.args).slice(0, 200)}`);
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
        this.log('tool_result', `${event.ok ? 'ok' : 'fail'}: ${event.summary.slice(0, 200)}`);
        return;
      }
      case 'metrics': {
        this.post({ type: 'metricsUpdate', sessionId: this.id, metrics: event.metrics });
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
        this.log('final', event.text.slice(0, 300));
        if (this.mode === 'plan') {
          this.finalizeStreamingAssistant('', true); // drop the plain assistant bubble, we render a 'plan' card instead
          const id = genId('plan');
          const entry: UiTranscriptEntry = { kind: 'plan', id, text: event.text, executed: false };
          this.lastPlan = { entryId: id, text: event.text };
          this.pushEntry(entry);
          this.post({ type: 'entry', sessionId: this.id, entry });
        } else {
          this.finalizeStreamingAssistant(event.text, false, event.unverifiedClaims);
        }
        return;
      }
      case 'error': {
        this.flush();
        this.finalizeStreamingAssistant('', true);
        const entry: UiTranscriptEntry = { kind: 'error', id: genId('e'), text: event.message };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        this.log('error', event.message);
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

  private finalizeStreamingAssistant(fallbackText: string, forceDrop = false, unverifiedClaims?: string[]) {
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
        if (unverifiedClaims?.length) entry.unverifiedClaims = unverifiedClaims;
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
