import * as vscode from 'vscode';
import { OllamaClient } from '../ollama/client';
import { ChatMessage } from '../ollama/types';
import { PendingEditManager } from '../tools/editApply';
import { BackgroundProcessManager } from '../tools/backgroundProcessManager';
import { ApprovalBroker } from '../agent/approvalBroker';
import { runAgentTurn } from '../agent/agentLoop';
import { AgentEvent } from '../agent/types';
import { ForgeMode, isAutonomousMode, modeSupportsVerifyCommand } from '../agent/modes';
import { CheckpointStore } from '../agent/checkpoints';
import { CompactionCache } from '../agent/contextManager';
import { WorkspaceIndex } from '../indexing/workspaceIndex';
import { ChatMemoryIndex, extractSearchableText } from '../indexing/chatMemoryIndex';
import { RulesEngine } from '../forge/rules';
import { SkillsEngine } from '../forge/skills';
import { HookRunner } from '../forge/hooks';
import { MemoryStore } from '../forge/memory';
import { reviewForMemoryFacts } from '../forge/memoryReview';
import { ChatStore, StoredSession, deriveTitle } from '../forge/chatStore';
import { deriveMilestoneSummary, renderMilestonesForPrompt } from './milestones';
import { WebSearchService } from '../websearch/searchService';
import { WebFetchService } from '../websearch/fetchService';
import { getConfig, resolveModelForMode } from '../util/config';
import { genId } from '../util/ids';
import { toRelative } from '../util/paths';
import { logger } from '../util/logger';
import { ExtensionToWebviewMessage, SessionState, UiTranscriptEntry } from '../webview/protocol';

/** How many completed turns pass between automatic memory-review sweeps (see ChatSession.maybeReviewForMemory) — frequent enough to catch things before a session ends, rare enough that it's not a network call on every single turn. */
const MEMORY_REVIEW_INTERVAL = 6;

export interface ChatSessionServices {
  ollama: OllamaClient;
  pendingEdits: PendingEditManager;
  backgroundProcesses: BackgroundProcessManager;
  workspaceIndex: WorkspaceIndex;
  chatMemoryIndex: ChatMemoryIndex;
  rules: RulesEngine;
  skills: SkillsEngine;
  hooks: HookRunner;
  memory: MemoryStore;
  chatStore: ChatStore;
  webSearchService: WebSearchService;
  webFetchService: WebFetchService;
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
  /** True once the user has explicitly renamed this chat via rename() — guards the first-message auto-title logic in send() from silently overwriting a manual rename. */
  private titleManuallySet = false;
  mode: ForgeMode = 'agent';
  model = ''; // '' = use the global default chat model
  /** Optional "definition of done" shell command — see modes.ts's modeSupportsVerifyCommand. '' = none configured. */
  verifyCommand = '';
  /** Per-chat context-window override (item "tweak context limits per chat") — undefined = use the global forge.numCtx default. See setNumCtxOverride(). */
  numCtxOverride: number | undefined;
  uiHistory: UiTranscriptEntry[] = [];
  modelHistory: ChatMessage[] = [];
  busy = false;
  private createdAt: string;

  private cts: vscode.CancellationTokenSource | undefined;
  private approvalBroker: ApprovalBroker;
  private lastPlan: { entryId: string; text: string } | undefined;
  private currentAssistantId: string | undefined;
  private currentVerifyId: string | undefined;
  private streamMode = new Map<string, 'pending' | 'live' | 'suppressed'>();
  private peek = new Map<string, string>();
  private postedLive = new Set<string>();
  private tokenBuffer = new Map<string, string>();
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private checkpoints = new CheckpointStore();
  private compactionCache: CompactionCache | undefined;
  private beforeWriteSub: vscode.Disposable;
  private turnsSinceMemoryReview = 0;
  /** Tracks the in-progress 'subagent' transcript entry per nesting depth, so a matching subagent_result event (same depth) can find and update it — see handleAgentEvent's 'subagent_start'/'subagent_result' cases. */
  private subAgentEntryByDepth = new Map<number, string>();

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
      // Auto and Outcome modes are both fully autonomous (item #2, plus the
      // 0.7.0 fix for Outcome mode silently still requiring approvals) — no
      // command approval gate, except the hard-coded dangerous-command
      // denylist ApprovalBroker itself always enforces regardless of this flag.
      () => (isAutonomousMode(this.mode) ? false : getConfig().requireApprovalForCommands)
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
    s.verifyCommand = stored.verifyCommand || '';
    s.turnsSinceMemoryReview = stored.turnsSinceMemoryReview || 0;
    s.titleManuallySet = stored.titleManuallySet || false;
    s.numCtxOverride = stored.numCtxOverride;
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
      verifyCommand: this.verifyCommand || undefined,
      turnsSinceMemoryReview: this.turnsSinceMemoryReview,
      titleManuallySet: this.titleManuallySet || undefined,
      numCtxOverride: this.numCtxOverride,
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
      checkpoints: this.checkpoints.list().map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, milestone: c.milestone })),
      verifyCommand: this.verifyCommand || undefined,
      numCtxOverride: this.numCtxOverride,
    };
  }

  /** Releases the shared PendingEditManager subscription. Call this whenever a session is removed from ChatViewProvider's in-memory map (closed/deleted), so closing many tabs over a long-running VS Code session doesn't accumulate dead listeners on the workspace-wide PendingEditManager. */
  dispose() {
    this.beforeWriteSub.dispose();
  }

  private persist() {
    this.services.chatStore.save(this.toStored()).catch((err) => logger.warn('session persist failed', String(err)));
  }

  private log(kind: 'user' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'checkpoint' | 'mode_change' | 'verify' | 'memory_review', detail: string) {
    this.services.chatStore.appendLog(this.id, { ts: nowIso(), kind, detail }).catch(() => {});
  }

  setMode(mode: ForgeMode) {
    this.mode = mode;
    this.log('mode_change', mode);
    this.persist();
    this.postModeChanged();
  }

  /**
   * Item "doesn't recognize that the mode has changed, keeps saying I am in
   * ask mode when it's in agent mode or auto mode": the webview only ever
   * learned the current mode from a full `sessionSwitched`/`init` payload —
   * anything that changed `this.mode` WITHOUT going through one of those
   * (setMode already posts a full session switch's worth of state today, but
   * executePlan's own agent-mode handoff never notified the webview at all)
   * left the composer's mode pill silently stale. This posts a small,
   * dedicated event so the webview updates immediately regardless of which
   * code path changed the mode — see media/webview.js's `case 'modeChanged'`.
   */
  private postModeChanged() {
    this.post({ type: 'modeChanged', sessionId: this.id, mode: this.mode });
  }

  /** Sets (or clears, with '') this chat's own model override — see model, resolveModelForMode(). Takes effect on the next send(), no restart needed. */
  setModelOverride(model: string) {
    this.model = model.trim();
    this.persist();
  }

  /** Sets or clears this session's "definition of done" command (see modes.ts's modeSupportsVerifyCommand) — takes effect on the next send(), no restart needed. */
  setVerifyCommand(command: string) {
    this.verifyCommand = command.trim();
    this.persist();
  }

  /** Explicit user rename (item #5) — CHAT_RENAME. Marks the title as manually set so the first-message auto-title in send() never overwrites it again, including on chats renamed before their first message is sent. */
  rename(title: string) {
    const clean = title.trim();
    if (!clean) return;
    this.title = clean;
    this.titleManuallySet = true;
    this.persist();
  }

  /** Sets (or clears, with undefined/NaN) this chat's own context-window override — see numCtxOverride. Takes effect on the next send(), no restart needed. */
  setNumCtxOverride(numCtx: number | undefined) {
    this.numCtxOverride = numCtx && Number.isFinite(numCtx) && numCtx > 0 ? Math.floor(numCtx) : undefined;
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

  /**
   * Item "Ability to fork chats and revert back the chat to a particular
   * point": non-destructively duplicates this session as a brand-new chat,
   * truncated at `checkpointId` — the fork's transcript/checkpoint list end
   * up exactly where restoreCheckpoint(id) would have left THIS session,
   * except THIS session is completely untouched (uses resolveRestore(), not
   * applyRestore(), and never mutates this.uiHistory/modelHistory/checkpoints).
   * That's the whole point over "restore to here": you get to keep exploring
   * both the original line of conversation and a new one from that branch
   * point, instead of the original ending being deleted forever.
   *
   * File state is the one place a fork can't fully honor "non-destructive":
   * Forge has a single physical workspace per project, not a per-chat
   * worktree (see checkpoints.ts's known-limitation doc comment), so there
   * is only one real copy of each file on disk. Forking still applies the
   * checkpoint's file reversion to that one shared workspace, so the new
   * chat's transcript is consistent with what you'll actually see on disk —
   * but if you then keep working in the ORIGINAL chat's tab, its later edits
   * to those same files are only back on disk once IT writes again. Same
   * tradeoff restoreCheckpoint already has, just without deleting anything.
   */
  async forkAt(checkpointId: string): Promise<{ ok: boolean; message: string; forkedSession?: ChatSession }> {
    const resolved = this.checkpoints.resolveRestore(checkpointId);
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
        logger.warn('checkpoint fork failed for', relPath, String(err));
      }
    }

    const forked = new ChatSession(this.services, this.notify);
    forked.title = deriveTitle(`${this.title} (fork)`);
    forked.titleManuallySet = true; // this title is already meaningful — don't let the first-message auto-title logic overwrite it
    forked.mode = this.mode;
    forked.model = this.model;
    forked.verifyCommand = this.verifyCommand;
    forked.numCtxOverride = this.numCtxOverride;
    // Deep-clone via JSON round-trip: these are plain, serializable objects
    // (the same shape persisted to disk), so this is cheap and — more
    // importantly — guarantees the fork shares no mutable object references
    // with the original. Without it, a later in-place mutation on the
    // original (e.g. a still-in-flight verify/subagent entry being updated)
    // could bleed into the fork's supposedly-frozen history.
    forked.uiHistory = JSON.parse(JSON.stringify(this.uiHistory.slice(0, resolved.target.uiHistoryIndex)));
    forked.modelHistory = JSON.parse(JSON.stringify(this.modelHistory.slice(0, resolved.target.modelHistoryLength)));
    forked.checkpoints = CheckpointStore.fromJSON(JSON.parse(JSON.stringify(resolved.remaining)));
    forked.uiHistory.push({ kind: 'system', id: genId('sys'), text: `Forked from "${this.title}" at checkpoint "${resolved.target.label}".` });
    forked.persist();

    return {
      ok: true,
      message: `Forked into a new chat "${forked.title}" — reverted ${filesTouched} shared workspace file(s) to match "${resolved.target.label}". The original chat is untouched.`,
      forkedSession: forked,
    };
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
    this.postModeChanged();
    await this.send('Execute the approved plan above, step by step.', [], { planContext: plan });
  }

  async send(text: string, files: string[], opts?: { planContext?: string }) {
    if (this.busy) {
      this.post({ type: 'toast', level: 'warn', text: 'This chat is still working — stop it first, or switch to another tab.' });
      return;
    }
    const cfg = getConfig();
    const model = resolveModelForMode(this.mode, this.model, cfg);
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

    if (this.uiHistory.length === 0 && !this.titleManuallySet) this.title = deriveTitle(text);

    // Item #3: a checkpoint begins with every turn — nothing is snapshotted
    // yet (see checkpoints.ts), just a marker that "before this point"
    // begins here, so any files touched from here on can be reverted later
    // via restoreCheckpoint(). autoModeSelected reflects the mode this
    // *specific* turn will run in, so a checkpoint label is accurate even if
    // the user flips modes right after sending.
    const checkpointId = genId('ckpt');
    const turnStartUiIndex = this.uiHistory.length;
    this.checkpoints.begin({
      id: checkpointId,
      label: deriveTitle(text),
      createdAt: nowIso(),
      uiHistoryIndex: turnStartUiIndex,
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
    // Item "based on the prompt relevant portions of the memory are selected
    // rather than all": pass this turn's own text as the relevance query —
    // see MemoryStore.renderForPrompt()'s doc comment for why this only
    // changes anything once the fact list is already too big to fit in full.
    const memoryText = await this.services.memory.renderForPrompt(effectiveText);
    const milestonesText = renderMilestonesForPrompt(this.checkpoints.list());
    // Item "documentation skill... progress through a project can become
    // context for new chats": every chat — not just this one — gets a digest
    // of what's already happened elsewhere in the project, so a brand-new
    // chat isn't starting from zero. See ChatStore.readProjectLogForPrompt().
    const projectLogText = await this.services.chatStore.readProjectLogForPrompt();

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
          backgroundProcesses: this.services.backgroundProcesses,
          approvalBroker: this.approvalBroker,
          hooks: this.services.hooks,
          codebaseSearch: (q, k) => this.services.workspaceIndex.search(q, k),
          rememberFact: (fact) => this.services.memory.addFact(fact),
          chatMemorySearch: (q, k) => this.services.chatMemoryIndex.search(q, k),
          // Item "web search": only wired up when explicitly enabled — see
          // the doc comment on ToolExecContext.webSearch in agent/types.ts
          // for why this is Forge's one opt-in-required tool.
          webSearch: cfg.webSearchEnabled ? (q) => this.services.webSearchService.search(q) : undefined,
          webFetch: cfg.webSearchEnabled ? (url, offset, length) => this.services.webFetchService.fetch(url, offset, length) : undefined,
          workspaceRoot: this.services.workspaceRoot,
          workspaceName: this.services.workspaceName,
        },
        (event) => this.handleAgentEvent(event),
        this.cts.token,
        model,
        {
          mode: this.mode,
          rulesText: rulesText || undefined,
          memoryText: memoryText || undefined,
          milestonesText,
          projectLogText: projectLogText || undefined,
          planContext: opts?.planContext,
          compactionCache: this.compactionCache,
          verifyCommand: modeSupportsVerifyCommand(this.mode) && this.verifyCommand ? this.verifyCommand : undefined,
          numCtx: this.numCtxOverride,
        }
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
      // Milestone logging (item "documenting all milestones, logging
      // checkpoints so context can be derived from that") — a mechanical,
      // zero-cost digest of what THIS turn actually did, attached to its
      // checkpoint. Runs even if the turn errored/was aborted above (the
      // digest just reflects whatever entries actually landed), but not if
      // the checkpoint itself was already dropped by a restore that
      // happened mid-turn (setMilestone no-ops on a missing id).
      const milestone = deriveMilestoneSummary(this.uiHistory.slice(turnStartUiIndex));
      this.checkpoints.setMilestone(checkpointId, milestone);
      this.persist();
      // Item "documentation skill": feed the exact same mechanically-generated
      // digest into the workspace-wide project log — "unify into one system,"
      // not a fourth logging mechanism alongside the per-turn milestone, the
      // per-session crash-recovery log, and this. Best-effort/fire-and-forget,
      // same as the chat-memory indexing call just below.
      if (milestone) this.services.chatStore.appendProjectLog(this.title, milestone).catch((err) => logger.warn('project log append failed', String(err)));
      // Keep search_chat_history current — incremental (see ChatMemoryIndex),
      // so this is cheap on every turn except when this session actually
      // grew. Best-effort: a memory-index failure must never break the turn
      // that just completed.
      this.services.chatMemoryIndex.indexSession(this.toStored()).catch((err) => logger.warn('chat memory indexing failed', String(err)));
      this.maybeReviewForMemory();
    }
  }

  /**
   * Automatic half of the memory system (item "add these features" —
   * automatic memory extraction, complementing the model-initiated
   * `remember` tool call from the memory system's first pass). Fires at
   * most once every MEMORY_REVIEW_INTERVAL completed turns, always
   * fire-and-forget so a slow/unreachable Ollama can never hold up the turn
   * that just finished. Every fact it proposes still goes through
   * MemoryStore.addFact()'s de-dupe, so an over-eager review can only ever
   * add a fact once.
   */
  private maybeReviewForMemory() {
    this.turnsSinceMemoryReview++;
    if (this.turnsSinceMemoryReview < MEMORY_REVIEW_INTERVAL) return;
    this.turnsSinceMemoryReview = 0;
    this.persist();

    const cfg = getConfig();
    const model = this.model || cfg.chatModel;
    if (!model) return;
    const recent = { uiHistory: this.uiHistory.slice(-24) } as StoredSession;
    const excerpt = extractSearchableText(recent);

    this.runMemoryReview(excerpt, model).catch((err) => logger.warn('automatic memory review failed', String(err)));
  }

  private async runMemoryReview(excerpt: string, model: string) {
    const existingFacts = await this.services.memory.listFacts();
    const facts = await reviewForMemoryFacts(excerpt, this.services.ollama, model, existingFacts);
    if (facts.length === 0) return;
    let added = 0;
    for (const fact of facts) {
      const result = await this.services.memory.addFact(fact);
      if (result.added) added++;
    }
    if (added > 0) {
      this.log('memory_review', `auto-remembered ${added} fact(s): ${facts.slice(0, added).join('; ')}`);
      this.services.chatStore
        .appendProjectLog(this.title, `Auto-remembered ${added} fact(s) from conversation: ${facts.slice(0, added).join('; ')}`)
        .catch((err) => logger.warn('project log append failed', String(err)));
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
      case 'verify_start': {
        this.flush();
        // Unlike a tool call (where the preceding "thinking" text is usually
        // just filler and gets dropped), the text here is the model's actual
        // attempted final answer — show it as a real bubble even if the
        // verify check below is about to send the turn around again, so the
        // user can see what it claimed.
        this.finalizeStreamingAssistant(event.draftText, false);
        const entry: UiTranscriptEntry = { kind: 'verify', id: genId('vf'), command: event.command, status: 'running' };
        this.currentVerifyId = entry.id;
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        return;
      }
      case 'verify_result': {
        const idx = this.currentVerifyId ? this.uiHistory.findIndex((e) => e.id === this.currentVerifyId) : -1;
        if (idx >= 0) {
          const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'verify' }>;
          entry.status = 'done';
          entry.ok = event.ok;
          entry.summary = event.summary;
          this.pushEntry(entry, true);
          this.post({ type: 'entryUpdate', sessionId: this.id, entry });
        }
        this.currentVerifyId = undefined;
        this.log('verify', `${event.command} — ${event.ok ? 'passed' : 'failed'}: ${event.summary.slice(0, 200)}`);
        return;
      }
      case 'verify_gaming_warning': {
        // Item "Outcome mode introduces cheap tricks bypass" — advisory
        // only, the turn already completed successfully; this just flags
        // that the fix which made the check pass looks suspicious (see
        // agent/gamingDetection.ts) so the user knows to take a closer
        // look before trusting the "done" result.
        const paths = [...new Set(event.findings.map((f) => f.path))];
        const text = `Heads up: the definition-of-done check passed, but ${event.findings.length === 1 ? 'an edit' : 'edits'} made right before it looks like it may have gamed the check rather than fixed the underlying issue — worth a second look at ${paths.join(', ')}.`;
        const entry: UiTranscriptEntry = { kind: 'warning', id: genId('warn'), text, details: event.findings };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        this.log('verify', `possible verify-bypass gaming detected: ${event.findings.map((f) => `${f.path} (${f.reason})`).join('; ')}`);
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
      case 'status': {
        // Item "brief messages to indicate what the AI agent and AI model is
        // doing" — a lightweight, ephemeral line (not persisted to
        // uiHistory/disk) shown in the composer footer while the agent
        // works. The webview itself honors forge.showStatusMessages to hide
        // it entirely if the user doesn't want it.
        this.post({ type: 'statusUpdate', sessionId: this.id, text: event.text, activity: event.activity });
        return;
      }
      case 'subagent_start': {
        this.flush();
        const id = genId('sa');
        this.subAgentEntryByDepth.set(event.depth, id);
        const entry: UiTranscriptEntry = { kind: 'subagent', id, task: event.task, status: 'running', depth: event.depth };
        this.pushEntry(entry);
        this.post({ type: 'entry', sessionId: this.id, entry });
        this.log('tool_call', `spawn_subagent (depth ${event.depth}): ${event.task.slice(0, 200)}`);
        return;
      }
      case 'subagent_result': {
        const entryId = this.subAgentEntryByDepth.get(event.depth);
        const idx = entryId ? this.uiHistory.findIndex((e) => e.id === entryId) : -1;
        if (idx >= 0) {
          const entry = this.uiHistory[idx] as Extract<UiTranscriptEntry, { kind: 'subagent' }>;
          entry.status = 'done';
          entry.ok = event.ok;
          entry.summary = event.summary;
          this.pushEntry(entry, true);
          this.post({ type: 'entryUpdate', sessionId: this.id, entry });
        }
        this.subAgentEntryByDepth.delete(event.depth);
        this.log('tool_result', `spawn_subagent (depth ${event.depth}) ${event.ok ? 'ok' : 'fail'}: ${event.summary.slice(0, 200)}`);
        return;
      }
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
