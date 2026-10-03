import * as vscode from 'vscode';
import { pickBestDefaultModel } from '../ollama/client';
import { LlmProvider } from '../llm/provider';
import { PendingEditManager } from '../tools/editApply';
import { BackgroundProcessManager } from '../tools/backgroundProcessManager';
import { openDiffForEdit } from '../tools/diffContentProvider';
import { WorkspaceIndex } from '../indexing/workspaceIndex';
import { ChatMemoryIndex } from '../indexing/chatMemoryIndex';
import { RulesEngine } from '../forge/rules';
import { SkillsEngine } from '../forge/skills';
import { HookRunner } from '../forge/hooks';
import { MemoryStore } from '../forge/memory';
import { ChatStore, SessionSummary } from '../forge/chatStore';
import { PROVIDERS, WebSearchService } from '../websearch/searchService';
import { WebFetchService } from '../websearch/fetchService';
import { WebSearchKeyStore, SECRET_BACKED_PROVIDERS } from '../websearch/keyStore';
import { McpManager } from '../mcp/mcpManager';
import { ForgeMode, MODES } from '../agent/modes';
import { getConfig, setChatModel, setForgeSetting, setMlxChatModel, userConfiguredRecommendationKeys } from '../util/config';
import { genId } from '../util/ids';
import { resolveWorkspacePath, toRelative } from '../util/paths';
import { WorkspaceEntryIndex } from '../util/fileSearch';
import { estimateSuggestedNumCtx, getGpuStatus, getRamStatus } from '../util/hwMetrics';
import { HwSampler, hwFieldsForUi, readMachineProfile } from '../util/hwSampler';
import { recommend } from '../util/recommendations';
import { logger } from '../util/logger';
import { ChatSession, ChatSessionServices } from './chatSession';
import { ExtensionToWebviewMessage, HwStatus, InitState, SearchResultItem, SettingsSnapshot, UiTranscriptEntry, WebviewToExtensionMessage } from '../webview/protocol';
import { OllamaCallMetrics, OllamaPsModel } from '../ollama/types';
import { contextUsedTokens } from '../util/contextUsage';

/**
 * Thin webview host + multi-session ("multitask") manager. All the actual
 * agent-turn logic lives in ChatSession; this class owns which sessions are
 * open, which one is currently shown in the webview, and the workspace-wide
 * shared services every session draws on (Ollama client, pending edits,
 * workspace index, rules/skills/hooks).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * Item 3: "a Claude Code-like extension UI which opens separate from the
   * file explorer/extension pane." VS Code's sidebar view (`this.view`
   * above) always lives in the Activity Bar's side panel alongside the file
   * explorer — there's no API to make a WebviewView itself pop out
   * elsewhere. A `vscode.WebviewPanel` (opened via openPanel(), see below)
   * is the actual "separate window" primitive: it opens as its own tab in
   * the main editor area (`ViewColumn.Beside` by default), fully detached
   * from the sidebar, closeable/moveable/splittable like any editor tab —
   * which is exactly how Claude Code's own terminal-based UI feels distinct
   * from a sidebar panel. Both this and `this.view` render the SAME
   * `getHtml()`/webview.js bundle and share every bit of session state
   * (this.sessions, this.activeSessionId, all of `services`) — post()/
   * notify() broadcast to whichever of the two are currently open, so
   * they're two live views onto one shared chat, not two separate chats.
   */
  private panel: vscode.WebviewPanel | undefined;
  private sessions = new Map<string, ChatSession>();
  private activeSessionId: string | undefined;
  private entryIndex: WorkspaceEntryIndex;
  private services: ChatSessionServices;
  /** Last completed call's metrics per session, so buildHwStatus() can report context-window usage (item "context usage metrics") without threading metrics through every call site. Best-effort/ephemeral — never persisted. */
  private lastMetricsBySession = new Map<string, OllamaCallMetrics>();

  /**
   * Serializes the session-management operations (new/switch/close/delete/
   * rename) against EACH OTHER. `webviewView.webview.onDidReceiveMessage`
   * invokes `handleMessage` without awaiting it, so if the user clicks
   * around quickly — e.g. two tabs in succession, or close right after
   * switch — multiple of these can genuinely run concurrently. Whichever one
   * happens to finish its own async work (loading a not-yet-in-memory
   * session from disk, etc.) LAST wins and silently overwrites
   * `this.activeSessionId`/`this.sessions`, even if it was the one the user
   * triggered first — this is the direct cause of "I clicked a chat and it
   * just didn't open" (it opened, then an in-flight earlier/slower op
   * finished after and reverted the switch). Routing these five operations
   * through one FIFO queue makes them fully sequential, so the last one
   * *requested* is always the last one applied. Deliberately narrow: `send`/
   * `stop`/every other message type is untouched and stays fully
   * concurrent — an agent turn in flight must never block clicking Stop or
   * switching tabs.
   */
  private sessionOpQueue: Promise<any> = Promise.resolve();
  private enqueueSessionOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sessionOpQueue.then(fn, fn);
    this.sessionOpQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Monotonic counters for `sessionsList`/`allChatsList`, incremented at
   * the moment each push is CALLED (not when its async read resolves).
   * `pushSessionsList`/`pushAllChatsList` are called from many independent
   * places (session-management ops above, and background sessions'
   * `notify()` on every `busy` event) and each does its own async
   * `chatStore.listSessions()` read before posting — two overlapping calls
   * can resolve in the opposite order they were started in, so without a
   * sequence number a slightly-stale snapshot from an earlier call can land
   * at the webview AFTER a fresher one and silently roll the tab strip back
   * (a closed/renamed chat "flickering" back to its old state). The webview
   * keeps the highest seq it has applied per message type and ignores
   * anything older — see webview.js's `case 'sessionsList'`/`'allChatsList'`.
   */
  private sessionsListSeq = 0;
  private allChatsListSeq = 0;

  /** One shared sampler for every webview host (v0.15.0 §1.4) — pushes accurate memory/GPU readings instead of waiting for a click. */
  private readonly hwSampler = new HwSampler();
  private psCache: { at: number; value: Awaited<ReturnType<LlmProvider['ps']>> } | undefined;
  private hwPushInFlight = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ollama: LlmProvider,
    private readonly pendingEdits: PendingEditManager,
    private readonly backgroundProcesses: BackgroundProcessManager,
    private readonly workspaceIndex: WorkspaceIndex,
    private readonly chatMemoryIndex: ChatMemoryIndex,
    private readonly rules: RulesEngine,
    private readonly skills: SkillsEngine,
    private readonly hooks: HookRunner,
    private readonly memory: MemoryStore,
    private readonly chatStore: ChatStore,
    private readonly webSearchService: WebSearchService,
    private readonly webFetchService: WebFetchService,
    private readonly keyStore: WebSearchKeyStore,
    private readonly mcpManager: McpManager,
    private readonly workspaceRoot: vscode.Uri,
    private readonly workspaceName: string,
    private readonly ensureMlx?: () => Promise<void>
  ) {
    this.services = { ollama, pendingEdits, backgroundProcesses, workspaceIndex, chatMemoryIndex, rules, skills, hooks, memory, chatStore, webSearchService, webFetchService, mcpManager, workspaceRoot, workspaceName, hwSnapshot: () => this.hwSampler.latest() };
    this.entryIndex = new WorkspaceEntryIndex(workspaceRoot);
    this.pendingEdits.onDidChange((edits) => this.post({ type: 'pendingEdits', edits }));
    this.hwSampler.start(2000, () => void this.pushHwStatus());
  }

  /** Stops the hardware sampler (called from extension deactivation via context.subscriptions). */
  dispose() {
    this.hwSampler.stop();
  }

  /** Pushes a fresh hardware readout to any open webview host; skipped entirely when none is open (no point building it), and never overlaps itself. */
  private async pushHwStatus() {
    if (!this.view && !this.panel) return;
    if (this.hwPushInFlight) return;
    this.hwPushInFlight = true;
    try {
      this.post({ type: 'hwStatus', status: await this.buildHwStatus() });
    } catch (err) {
      logger.warn('pushHwStatus failed', String(err));
    } finally {
      this.hwPushInFlight = false;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => this.handleMessage(msg, webviewView.webview));
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  focus() {
    this.view?.show?.(true);
  }

  /**
   * Item 3: opens (or, if already open, reveals/refocuses) the detached
   * "Forge" panel — see the `panel` field's doc comment above for why this
   * is the actual "separate from the sidebar" primitive. Registered as the
   * **Forge: Open Chat in New Panel** command (see commands.ts/package.json)
   * and, for discoverability, a title-bar icon on the sidebar view itself —
   * the same "pop out into its own tab" affordance most editors offer for a
   * side panel.
   */
  openPanel() {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'forge.chatPanel',
      'Forge',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // Keeps the panel's DOM (composer draft, scroll position, streaming
        // state) alive when it's not the focused editor tab — same reasoning
        // as the sidebar view's identical option in extension.ts, and doubly
        // important here since a detached panel is much more likely to be
        // backgrounded behind other editor tabs than the always-visible
        // sidebar is.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      }
    );
    try {
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'activitybar-icon.svg');
    } catch {
      /* cosmetic only — a missing icon must never prevent the panel from opening */
    }
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => this.handleMessage(msg, panel.webview));
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  async addFileToContext(uri: vscode.Uri) {
    this.focus();
    const rel = toRelative(this.workspaceRoot, uri);
    this.post({ type: 'prefill', text: '', files: [rel] });
  }

  addSelectionToChat(editor: vscode.TextEditor) {
    this.focus();
    const rel = toRelative(this.workspaceRoot, editor.document.uri);
    const sel = editor.selection;
    const text = editor.document.getText(sel);
    const startLine = sel.start.line + 1;
    const endLine = sel.end.line + 1;
    const lang = editor.document.languageId;
    const quoted = `\n\n${rel} (lines ${startLine}-${endLine}):\n\`\`\`${lang}\n${text}\n\`\`\`\n`;
    this.post({ type: 'prefill', text: quoted });
  }

  async newChat() {
    return this.enqueueSessionOp(async () => {
      const session = new ChatSession(this.services, (id, msg) => this.notify(id, msg));
      this.sessions.set(session.id, session);
      this.activeSessionId = session.id;
      await session.runHookOnce('session-start');
      this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
      await this.pushSessionsList();
    });
  }

  /**
   * Run one file-mailbox task as a real Forge chat (same memory, project log,
   * history, and approval gates as a message typed in the panel). Session
   * setup goes through enqueueSessionOp, the same queue as newChat; the
   * send itself stays outside that queue so Stop and tab switches are not
   * blocked for the whole turn. A task that needs tool approval waits here
   * until the panel answers. A busy session is queued and this returns
   * without waiting for that later turn.
   */
  async runBridgeTask(t: { text: string; subject: string; from: string; sessionId?: string; mode?: ForgeMode }): Promise<{ ok: boolean; sessionId: string; finalText: string; error?: string }> {
    this.post({ type: 'toast', level: 'info', text: `Bridge task from ${t.from}: ${t.subject}` });
    try {
      if (t.sessionId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.sessionId)) {
        return { ok: false, sessionId: '', finalText: '', error: 'Invalid session id.' };
      }
      const ready = await this.enqueueSessionOp(async (): Promise<{ session?: ChatSession; fail?: { ok: boolean; sessionId: string; finalText: string; error?: string } }> => {
        if (t.sessionId) {
          const existing = await this.getOrLoadSession(t.sessionId);
          if (!existing) return { fail: { ok: false, sessionId: t.sessionId, finalText: '', error: `Unknown session: ${t.sessionId}` } };
          if (t.mode) existing.setMode(t.mode);
          await this.showSession(existing);
          return { session: existing };
        }
        const session = new ChatSession(this.services, (id, msg) => this.notify(id, msg));
        session.rename(`[bridge] ${t.subject}`.replace(/\s+/g, ' ').trim());
        this.sessions.set(session.id, session);
        await session.runHookOnce('session-start');
        session.setMode(t.mode ?? getConfig().bridgeDefaultMode);
        await this.showSession(session);
        return { session };
      });
      if (ready.fail) return ready.fail;
      const session = ready.session;
      if (!session) return { ok: false, sessionId: t.sessionId || '', finalText: '', error: 'Could not open a chat for this task.' };
      if (session.busy) {
        await session.send(t.text, []);
        return { ok: true, sessionId: session.id, finalText: 'Queued: the chat was busy; it will be handled in that session.' };
      }
      const start = session.uiHistory.length;
      await session.send(t.text, []);
      const since = session.uiHistory.slice(start);
      let finalText = '';
      for (const entry of since) {
        if (entry.kind === 'assistant') finalText = entry.text;
      }
      if (finalText.trim()) return { ok: true, sessionId: session.id, finalText };
      const errEntry = [...since].reverse().find((entry) => entry.kind === 'error');
      if (errEntry && errEntry.kind === 'error') return { ok: false, sessionId: session.id, finalText: errEntry.text, error: errEntry.text };
      const started = since.some((entry) => entry.kind === 'user');
      const why = started ? 'Forge finished without an answer.' : 'Forge did not start the turn (no model selected, or the provider is offline).';
      return { ok: false, sessionId: session.id, finalText: '', error: why };
    } catch (err: any) {
      return { ok: false, sessionId: t.sessionId || '', finalText: '', error: err?.message || String(err) };
    }
  }

  /** Make this chat the active tab and reveal the Forge view, the same way newChat does. */
  private async showSession(session: ChatSession) {
    this.activeSessionId = session.id;
    this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
    await this.pushSessionsList();
    this.focus();
    if (this.panel) this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside);
  }

  async refreshIndexStatus() {
    const status = this.workspaceIndex.status();
    this.post({ type: 'indexStatus', ...status });
  }

  /** Forwards session events to the webview only when that session is the one on screen, with one exception (`busy`) so background tabs can show a spinner. */
  private notify(sessionId: string, msg: ExtensionToWebviewMessage) {
    if (msg.type === 'metricsUpdate') this.lastMetricsBySession.set(sessionId, msg.metrics);
    if (msg.type === 'busy') {
      // A turn starting means "peak GPU this turn" should start from zero, and readings should refresh faster while work is happening.
      if (msg.busy) this.hwSampler.resetPeak();
      this.hwSampler.setIntervalMs(msg.busy ? 1000 : 3000);
    }
    if (sessionId === this.activeSessionId) {
      this.post(msg);
      if (msg.type === 'busy') this.pushSessionsList();
      return;
    }
    if (msg.type === 'busy') {
      this.post(msg); // background-tab activity indicator
      this.pushSessionsList();
    }
  }

  /** Broadcasts to every currently-open webview host — the sidebar view and/or the detached panel (item 3), whichever exist. A message meant for only ONE specific host (the 'init' response to that host's own 'ready') goes straight to that webview's postMessage instead — see sendInit()'s `target` param. */
  private post(message: ExtensionToWebviewMessage) {
    this.view?.webview.postMessage(message);
    this.panel?.webview.postMessage(message);
  }

  private async pushSessionsList() {
    // Captured synchronously, before the await below, so it reflects THIS
    // call's position in the call order — see the sessionsListSeq doc
    // comment up in the constructor area.
    const seq = ++this.sessionsListSeq;
    // The tab strip only ever shows OPEN chats — a chat that's been closed
    // (archived, see closeSession below) still exists in .forge/chat/ and is
    // reachable from the "All chats" browser (listAllChats), but it's
    // deliberately filtered out here so closing a tab actually removes it
    // from the strip instead of it reappearing on the next list refresh.
    const persisted = (await this.chatStore.listSessions()).filter((s) => !s.closed);
    // Merge in any not-yet-persisted (brand new, empty) open sessions so they show up immediately.
    const known = new Map(persisted.map((s) => [s.id, s]));
    for (const s of this.sessions.values()) {
      if (!known.has(s.id)) known.set(s.id, { id: s.id, title: s.title, mode: s.mode, updatedAt: new Date().toISOString() });
    }
    this.post({ type: 'sessionsList', seq, sessions: [...known.values()], activeId: this.activeSessionId || '' });
  }

  /** Every persisted chat, open or closed, for the "All chats" browser — the one place closed chats are still visible/reachable. */
  private async pushAllChatsList() {
    const seq = ++this.allChatsListSeq;
    this.post({ type: 'allChatsList', seq, sessions: await this.chatStore.listSessions() });
  }

  /**
   * After the active session gets closed or deleted, picks what to show
   * instead: another currently-open in-memory session, else the
   * most-recently-updated OPEN persisted session, else a brand-new chat
   * (Forge never leaves the UI with no active session at all). Shared by
   * closeSession and deleteSession so the fallback logic can't drift
   * between the two.
   */
  private async replaceActiveSession() {
    let next: ChatSession | undefined = [...this.sessions.values()][0];
    if (!next) {
      const persisted = (await this.chatStore.listSessions()).filter((s) => !s.closed);
      if (persisted.length > 0) next = await this.getOrLoadSession(persisted[0].id);
    }
    if (!next) {
      next = new ChatSession(this.services, (id, m) => this.notify(id, m));
      this.sessions.set(next.id, next);
    }
    this.activeSessionId = next.id;
    this.post({ type: 'sessionSwitched', session: next.toSummaryState() });
  }

  private async getOrLoadSession(id: string): Promise<ChatSession | undefined> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    try {
      // ChatStore.load() already recovers a missing/corrupted session file
      // on its own (see recoverCorruptedSession — the fix for "older chats
      // sometimes won't open"), so this only returns undefined for an id
      // that genuinely never existed. The try/catch here is defense in
      // depth for anything else unexpected in the load/construct path
      // (an unanticipated legacy data shape, etc.): previously an exception
      // here would propagate as an unhandled rejection (handleMessage isn't
      // awaited by its caller) and switchSession would just silently do
      // nothing — exactly the "click a chat and it just won't open" symptom
      // with zero feedback. Now it's a real, loggable failure the caller can
      // turn into the error toast added in 0.8.1.
      const stored = await this.chatStore.load(id);
      if (!stored) return undefined;
      const session = ChatSession.fromStored(stored, this.services, (sid, msg) => this.notify(sid, msg));
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      logger.warn(`Failed to load chat session ${id}`, String(err));
      return undefined;
    }
  }

  private activeSession(): ChatSession | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
  }

  private async handleMessage(msg: WebviewToExtensionMessage, sourceWebview?: vscode.Webview) {
    switch (msg.type) {
      case 'ready':
        // Item 3 (detached panel): target only the webview that just loaded
        // — see sendInit()'s doc comment for why a broadcast here would be
        // wrong once two webview hosts can be open at once.
        await this.sendInit(sourceWebview);
        return;
      case 'send':
        await this.activeSession()?.send(msg.text, msg.files || []);
        return;
      case 'stop':
        this.activeSession()?.stop();
        return;
      case 'queueEdit':
        this.activeSession()?.editQueuedMessage(msg.id, msg.text);
        return;
      case 'queueRemove':
        this.activeSession()?.removeQueuedMessage(msg.id);
        return;
      case 'queueSendNow':
        await this.activeSession()?.sendQueuedNow(msg.id);
        return;
      case 'newChat':
        await this.newChat();
        return;
      case 'switchSession': {
        // Enqueued (see sessionOpQueue's doc comment) so a second click
        // (another tab, or the same one again) can't finish first and get
        // silently overwritten by this one finishing later, or vice versa —
        // whichever switch was requested LAST is always the one that ends
        // up active, matching what the user actually clicked most recently.
        await this.enqueueSessionOp(async () => {
          const session = await this.getOrLoadSession(msg.id);
          if (!session) {
            // Previously a silent no-op — from the user's side this looked
            // exactly like "I clicked a chat and nothing happened," with no
            // way to tell a real failure from a UI glitch. This is a genuine
            // failure (the session's .forge/chat/<id>.json is missing or
            // unreadable), so say so.
            this.post({ type: 'toast', level: 'error', text: "Couldn't open that chat — its saved data may be missing. Try again, or check it in All Chats." });
            return;
          }
          // Switching to a chat implies it's active/open again — this is how a
          // closed chat gets reopened from the "All chats" browser or a search
          // result. A no-op (cheap index write) if it wasn't closed.
          await this.chatStore.setClosed(msg.id, false);
          this.activeSessionId = session.id;
          this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
          await this.pushSessionsList();
        });
        return;
      }
      case 'closeSession': {
        // Closing a tab ARCHIVES the chat, it does not delete it: the
        // session file stays on disk under .forge/chat/, it's just hidden
        // from the open-tabs strip (see pushSessionsList's filter) until
        // reopened via switchSession (from the "All chats" browser or a
        // search result) or removed for good via deleteSession. This used
        // to permanently delete on close with no way back — see CHANGELOG.
        await this.enqueueSessionOp(async () => {
          const closing = this.sessions.get(msg.id);
          closing?.stop();
          closing?.dispose();
          this.sessions.delete(msg.id);
          await this.chatStore.setClosed(msg.id, true);
          if (this.activeSessionId === msg.id) await this.replaceActiveSession();
          await this.pushSessionsList();
          await this.pushAllChatsList();
          this.post({ type: 'toast', level: 'info', text: 'Chat closed — still saved, reopen it from All Chats.' });
        });
        return;
      }
      case 'deleteSession': {
        // The actually-destructive action, now separate from closing (see
        // above) — permanently removes the session file, its crash log, and
        // its entry from the chat-memory search index.
        await this.enqueueSessionOp(async () => {
          const deleting = this.sessions.get(msg.id);
          deleting?.stop();
          deleting?.dispose();
          this.sessions.delete(msg.id);
          await this.chatStore.delete(msg.id);
          this.chatMemoryIndex.removeSession(msg.id);
          this.historyCache.delete(msg.id);
          if (this.activeSessionId === msg.id) await this.replaceActiveSession();
          await this.pushSessionsList();
          await this.pushAllChatsList();
          this.post({ type: 'toast', level: 'info', text: 'Chat deleted permanently.' });
        });
        return;
      }
      case 'listAllChats':
        await this.pushAllChatsList();
        return;
      case 'setMode':
        this.activeSession()?.setMode(msg.mode);
        return;
      case 'executePlan':
        await this.activeSession()?.executePlan(msg.id);
        return;
      case 'resolveApproval':
        this.activeSession()?.resolveApproval(msg.callId, msg.approved);
        return;
      case 'acceptEdit':
        await this.pendingEdits.accept(msg.id);
        return;
      case 'rejectEdit':
        this.pendingEdits.reject(msg.id);
        return;
      case 'acceptAllEdits': {
        const n = await this.pendingEdits.acceptAll();
        this.post({ type: 'toast', level: 'info', text: `Applied ${n} edit(s).` });
        return;
      }
      case 'rejectAllEdits': {
        const n = this.pendingEdits.rejectAll();
        this.post({ type: 'toast', level: 'info', text: `Rejected ${n} edit(s).` });
        return;
      }
      case 'openDiff':
        await openDiffForEdit(this.pendingEdits, msg.id);
        return;
      case 'selectModel':
        await vscode.commands.executeCommand('forge.selectChatModel');
        await this.sendInit();
        return;
      case 'indexWorkspace':
        await vscode.commands.executeCommand('forge.indexWorkspace');
        return;
      case 'queryFiles': {
        const results = await this.entryIndex.query(msg.query);
        this.post({ type: 'filesResult', query: msg.query, results });
        return;
      }
      case 'openFile': {
        // Item #9: clickable file references (tool-card paths, and
        // backtick-quoted paths in prose — see webview.js's file-ref click
        // handler) route here. Try the file first, then a folder (reveal in
        // Explorer) since @-mentions can now attach either (item #5).
        //
        // Item "file references don't open on click": this used to build the
        // URI with a naive vscode.Uri.joinPath(workspaceRoot, msg.path)
        // instead of the same resolveWorkspacePath() every file tool already
        // uses. That matters because msg.path can carry things
        // joinPath doesn't normalize away — a leading "./", a leading "/"
        // that joinPath treats as an absolute-path replacement instead of a
        // workspace-relative one, or backslashes from a path that started
        // life on Windows — any of which silently produced a URI that didn't
        // point at the real file, so showTextDocument's rejection always hit
        // the "could not open" fallback. resolveWorkspacePath cleans exactly
        // that up (and, as a bonus, refuses anything that would escape the
        // workspace via "..").
        let uri: vscode.Uri;
        try {
          uri = resolveWorkspacePath(this.workspaceRoot, msg.path);
        } catch {
          vscode.window.showWarningMessage(`Could not open ${msg.path}`);
          return;
        }
        vscode.window.showTextDocument(uri).then(undefined, async () => {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
              await vscode.commands.executeCommand('revealInExplorer', uri);
              return;
            }
          } catch {
            /* fall through to the warning below */
          }
          vscode.window.showWarningMessage(`Could not open ${msg.path}`);
        });
        return;
      }
      case 'toggleTabCompletion':
        await vscode.workspace.getConfiguration('forge').update('enableTabCompletion', msg.enabled, vscode.ConfigurationTarget.Global);
        return;
      case 'restoreCheckpoint': {
        const session = this.activeSession();
        if (!session) return;
        const result = await session.restoreCheckpoint(msg.id);
        this.post({ type: 'checkpointRestored', sessionId: session.id, message: result.message, ok: result.ok });
        if (result.ok) this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
        return;
      }
      case 'forkChat': {
        // Registers a new session and switches the active tab to it, so —
        // like newChat/switchSession/closeSession/deleteSession/renameSession
        // — this goes through enqueueSessionOp to stay serialized against
        // those (see that queue's doc comment: this class of operation must
        // never interleave, or a concurrent switch/close could race the new
        // tab into an inconsistent state).
        await this.enqueueSessionOp(async () => {
          const session = this.activeSession();
          if (!session) return;
          const result = await session.forkAt(msg.id);
          this.post({ type: 'chatForked', sessionId: session.id, message: result.message, ok: result.ok });
          if (result.ok && result.forkedSession) {
            this.sessions.set(result.forkedSession.id, result.forkedSession);
            this.activeSessionId = result.forkedSession.id;
            this.post({ type: 'sessionSwitched', session: result.forkedSession.toSummaryState() });
            await this.pushSessionsList();
          }
        });
        return;
      }
      case 'searchChats': {
        const results = await this.searchAllChats(msg.query);
        this.post({ type: 'searchResults', query: msg.query, results });
        return;
      }
      case 'refreshHwStatus': {
        this.post({ type: 'hwStatus', status: await this.buildHwStatus() });
        return;
      }
      case 'setVerifyCommand': {
        this.activeSession()?.setVerifyCommand(msg.command);
        return;
      }
      case 'setOrchestrationMode': {
        this.activeSession()?.setOrchestrationEnabled(msg.enabled);
        return;
      }
      case 'renameSession': {
        // Item "CHAT RENAME": rename whichever session this is, whether it's
        // currently loaded into memory (use its own rename() so
        // titleManuallySet is set) or only on disk (rename via ChatStore
        // directly, from the All Chats panel).
        await this.enqueueSessionOp(async () => {
          const loaded = this.sessions.get(msg.id);
          if (loaded) loaded.rename(msg.title);
          else await this.chatStore.rename(msg.id, msg.title);
          await this.pushSessionsList();
          await this.pushAllChatsList();
          if (this.activeSessionId === msg.id) {
            const active = this.activeSession();
            if (active) this.post({ type: 'sessionSwitched', session: active.toSummaryState() });
          }
        });
        return;
      }
      case 'getSettings': {
        this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot(true) });
        return;
      }
      case 'refreshSettings': {
        this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot(true) });
        return;
      }
      case 'updateSetting': {
        const applied = await setForgeSetting(msg.key, msg.value);
        if (applied) this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot() });
        else this.post({ type: 'toast', level: 'error', text: `Unknown or disallowed setting "${msg.key}".` });
        return;
      }
      case 'setSessionNumCtx': {
        // Item "tweak context limits per chat": a per-session override of
        // forge.numCtx, so a chat pinned to a small/fast model can use a
        // bigger context window than the global default without changing
        // it for every other chat too. null clears the override.
        const session = this.activeSession();
        if (!session) return;
        session.setNumCtxOverride(msg.numCtx === null ? undefined : msg.numCtx);
        this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
        return;
      }
      case 'setSessionModel': {
        // Item "ability to run separate models in different chats" — the
        // resolution priority (session override > per-mode routing > global
        // default) already existed via resolveModelForMode(); the only thing
        // missing was ever actually populating a session's own override.
        const session = this.activeSession();
        if (!session) return;
        session.setModelOverride(msg.model);
        this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
        return;
      }
      case 'setMlxModel': {
        const id = (msg.model || '').trim();
        if (!id) return;
        await setMlxChatModel(id);
        if (this.ensureMlx) {
          try {
            await this.ensureMlx();
          } catch (err: any) {
            this.post({ type: 'toast', level: 'error', text: `MLX model set to ${id}, but the server could not restart: ${err?.message || err}` });
            return;
          }
        }
        this.post({ type: 'toast', level: 'info', text: `MLX model set to ${id}. The MLX server will restart with it.` });
        await this.sendInit();
        return;
      }
      case 'listBackgroundCommands': {
        this.post({ type: 'backgroundCommandsList', commands: this.backgroundProcesses.list() });
        return;
      }
      case 'killBackgroundCommand': {
        // Item "ability to kill commands while they are running from the
        // chat window" — reuses BackgroundProcessManager.kill(), the same
        // method the check_background_command tool's {"action":"kill"} path
        // already calls; this just exposes it as a direct user action
        // instead of requiring the model to be asked to do it.
        const result = this.backgroundProcesses.kill(msg.id);
        if (!result.found) {
          this.post({ type: 'toast', level: 'error', text: 'That background command is no longer tracked (it may have already finished).' });
        } else if (result.alreadyExited) {
          this.post({ type: 'toast', level: 'info', text: 'That command had already finished.' });
        } else {
          this.post({ type: 'toast', level: 'info', text: 'Stop signal sent.' });
        }
        this.post({ type: 'backgroundCommandsList', commands: this.backgroundProcesses.list() });
        return;
      }
      case 'setWebSearchApiKey': {
        // The webview can't touch vscode.SecretStorage directly, so it asks
        // the extension host to run the real command (which shows its own
        // provider quick-pick + password input box) and then refreshes the
        // panel so the newly-configured provider shows up immediately.
        await vscode.commands.executeCommand('forge.setWebSearchApiKey');
        this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot() });
        return;
      }
      case 'clearWebSearchApiKey': {
        if ((SECRET_BACKED_PROVIDERS as readonly string[]).includes(msg.providerId)) {
          await this.keyStore.clear(msg.providerId as any);
          this.post({ type: 'toast', level: 'info', text: `Cleared the stored API key for ${PROVIDERS.find((p) => p.id === msg.providerId)?.displayName || msg.providerId}.` });
        }
        this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot() });
        return;
      }
    }
  }

  private async loadedModelsCached(): Promise<OllamaPsModel[]> {
    const now = Date.now();
    if (!this.psCache || now - this.psCache.at > 4000) {
      this.psCache = { at: now, value: await this.ollama.ps().catch(() => []) };
    }
    return this.psCache.value;
  }

  /** Snapshot of every setting the in-webview Settings panel can read/write — see util/config.ts's SETTINGS_PANEL_KEYS. Async because provider-configured status reads vscode.SecretStorage. */
  private async buildSettingsSnapshot(refreshHw = false): Promise<SettingsSnapshot> {
    const cfg = getConfig();
    const webSearchProviders = await Promise.all(
      PROVIDERS.map(async (p) => {
        if (p.id === 'searxng') return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: !!cfg.webSearchSearxngUrl };
        if (!p.requiresApiKey) return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: true };
        const creds = await this.keyStore.get(p.id);
        return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: p.isConfigured(creds) };
      })
    );
    const snapshot: SettingsSnapshot = {
      provider: cfg.provider,
      thinking: cfg.thinking,
      terseSteps: cfg.terseSteps,
      contextAppendOnly: cfg.contextAppendOnly,
      traceEnabled: cfg.traceEnabled,
      numCtx: cfg.numCtx,
      maxAgentIterations: cfg.maxAgentIterations,
      autoModeMaxIterations: cfg.autoModeMaxIterations,
      temperature: cfg.temperature,
      requireApprovalForWrites: cfg.requireApprovalForWrites,
      requireApprovalForCommands: cfg.requireApprovalForCommands,
      keepAliveMinutes: cfg.keepAliveMinutes,
      subAgentModel: cfg.subAgentModel,
      subAgentMaxIterations: cfg.subAgentMaxIterations,
      maxSubAgentDepth: cfg.maxSubAgentDepth,
      showStatusMessages: cfg.showStatusMessages,
      loopDetectionEnabled: cfg.loopDetectionEnabled,
      structuredOutputEnabled: cfg.structuredOutputEnabled,
      planFirstEnabled: cfg.planFirstEnabled,
      requirementsEnabled: cfg.requirementsEnabled,
      requirementsMaxNudges: cfg.requirementsMaxNudges,
      requirementsShowInPrompt: cfg.requirementsShowInPrompt,
      verifyBeforeDone: cfg.verifyBeforeDone,
      verifyCommand: cfg.verifyCommand,
      verifyTimeoutSec: cfg.verifyTimeoutSec,
      contextPinnedUserMaxChars: cfg.contextPinnedUserMaxChars,
      selfCritiqueEnabled: cfg.selfCritiqueEnabled,
      bestOfNEnabled: cfg.bestOfNEnabled,
      costAwarePlanningEnabled: cfg.costAwarePlanningEnabled,
      reviewExpensivePlansEnabled: cfg.reviewExpensivePlansEnabled,
      expensivePlanReviewThreshold: cfg.expensivePlanReviewThreshold,
      mcpStatus: this.mcpManager.status(),
      webSearchEnabled: cfg.webSearchEnabled,
      webSearchProvider: cfg.webSearchProvider,
      webSearchMaxResults: cfg.webSearchMaxResults,
      webSearchRespectRobotsTxt: cfg.webSearchRespectRobotsTxt,
      webSearchSearxngUrl: cfg.webSearchSearxngUrl,
      webSearchProviders,
      mlxPromptCacheGB: cfg.mlxPromptCacheGB,
      mlxPrefillStepSize: cfg.mlxPrefillStepSize,
      mlxPromptCacheSize: cfg.mlxPromptCacheSize,
      mlxDecodeConcurrency: cfg.mlxDecodeConcurrency,
      mlxPromptConcurrency: cfg.mlxPromptConcurrency,
      mlxDraftModel: cfg.mlxDraftModel,
      mlxNumDraftTokens: cfg.mlxNumDraftTokens,
      ollamaNumBatch: cfg.ollamaNumBatch,
      maxContextFileKB: cfg.maxContextFileKB,
      singleMessageSharePct: cfg.singleMessageSharePct,
      maxOutputTokens: cfg.maxOutputTokens,
      maxOutputTokensCeiling: cfg.maxOutputTokensCeiling,
      recommendations: [],
      machineProfileSummary: undefined,
    };
    const snap = refreshHw ? await this.hwSampler.sampleOnce() : this.hwSampler.latest().sampledAtMs ? this.hwSampler.latest() : await this.hwSampler.sampleOnce();
    const loaded = await this.loadedModelsCached();
    const loadedGb = loaded[0]?.size ? loaded[0].size / 1024 / 1024 / 1024 : undefined;
    const profile = await readMachineProfile(undefined, process.platform, { loadedModelSizeGB: loadedGb, hwSnapshot: snap });
    const recommendations = recommend(
      profile,
      {
        provider: cfg.provider,
        numCtx: cfg.numCtx,
        mlxPromptCacheGB: cfg.mlxPromptCacheGB,
        mlxPromptCacheSize: cfg.mlxPromptCacheSize,
        mlxPrefillStepSize: cfg.mlxPrefillStepSize,
        mlxDecodeConcurrency: cfg.mlxDecodeConcurrency,
        mlxPromptConcurrency: cfg.mlxPromptConcurrency,
        mlxNumDraftTokens: cfg.mlxNumDraftTokens,
        ollamaNumBatch: cfg.ollamaNumBatch,
        maxOutputTokens: cfg.maxOutputTokens,
        maxOutputTokensCeiling: cfg.maxOutputTokensCeiling,
        keepAliveMinutes: cfg.keepAliveMinutes,
        maxContextFileKB: cfg.maxContextFileKB,
      },
      { modelSizeGB: loadedGb }
    );
    const parts: string[] = [];
    if (profile.chipName) parts.push(profile.chipName);
    if (profile.totalRamGB) parts.push(`${profile.totalRamGB} GB RAM`);
    if (profile.memory) parts.push(`${profile.memory.availableGB} GB available`);
    if (profile.memory?.pressure && profile.memory.pressure !== 'unknown') parts.push(`pressure ${profile.memory.pressure}`);
    if (loadedGb) parts.push(`model ~${loadedGb.toFixed(1)} GB resident`);
    const currentByKey: Record<string, number> = {
      numCtx: cfg.numCtx,
      'mlx.promptCacheGB': cfg.mlxPromptCacheGB,
      'mlx.prefillStepSize': cfg.mlxPrefillStepSize,
      'mlx.promptCacheSize': cfg.mlxPromptCacheSize,
      'mlx.decodeConcurrency': cfg.mlxDecodeConcurrency,
      'mlx.promptConcurrency': cfg.mlxPromptConcurrency,
      'mlx.numDraftTokens': cfg.mlxNumDraftTokens,
      'ollama.numBatch': cfg.ollamaNumBatch,
      maxOutputTokens: cfg.maxOutputTokens,
      maxOutputTokensCeiling: cfg.maxOutputTokensCeiling,
      keepAliveMinutes: cfg.keepAliveMinutes,
      maxContextFileKB: cfg.maxContextFileKB,
    };
    const userConfigured = userConfiguredRecommendationKeys();
    snapshot.recommendations = recommendations.map((r) => ({
      ...r,
      userConfigured: userConfigured[r.settingKey],
      userValue: currentByKey[r.settingKey],
    }));
    snapshot.userConfiguredRecommendationKeys = userConfigured;
    snapshot.machineProfileSummary = parts.length ? parts.join(' · ') : undefined;
    return snapshot;
  }

  /**
   * Item #6: searches every persisted chat's transcript (not just the open
   * one), across `.forge/chat/*.json`. Still a linear scan over messages
   * within each session — exact-substring highlighting wants the real text,
   * not an embedding, so this stays separate from ChatMemoryIndex's semantic
   * search — but no longer re-reads and re-parses every closed session's
   * JSON file from disk on every keystroke: `historyCache` remembers each
   * closed session's transcript keyed by its `updatedAt`, so a search only
   * pays the disk-read cost once per session per change, not once per
   * search call. Open sessions are cheap already (in-memory, no cache
   * needed) and always read live so a search reflects an in-flight turn.
   */
  private historyCache = new Map<string, { updatedAt: string; history: UiTranscriptEntry[] }>();

  private async historyForSearch(summary: SessionSummary): Promise<UiTranscriptEntry[]> {
    const open = this.sessions.get(summary.id);
    if (open) return open.uiHistory;
    const cached = this.historyCache.get(summary.id);
    if (cached && cached.updatedAt === summary.updatedAt) return cached.history;
    const history = (await this.chatStore.load(summary.id))?.uiHistory || [];
    this.historyCache.set(summary.id, { updatedAt: summary.updatedAt, history });
    return history;
  }

  private async searchAllChats(query: string): Promise<SearchResultItem[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: SearchResultItem[] = [];
    const summaries = await this.chatStore.listSessions();
    for (const summary of summaries) {
      if (results.length >= 50) break;
      const history = await this.historyForSearch(summary);
      for (const entry of history) {
        if (results.length >= 50) break;
        const text = 'text' in entry ? entry.text : '';
        if (!text || !text.toLowerCase().includes(q)) continue;
        const idx = text.toLowerCase().indexOf(q);
        const start = Math.max(0, idx - 40);
        const snippet = `${start > 0 ? '…' : ''}${text.slice(start, idx + q.length + 60)}${idx + q.length + 60 < text.length ? '…' : ''}`;
        results.push({ sessionId: summary.id, sessionTitle: summary.title || 'New chat', entryId: entry.id, snippet });
      }
    }
    return results;
  }

  /**
   * Item "HWD metrics": currently-loaded model(s) + VRAM footprint via GET
   * /api/ps (best-effort; an older/unreachable Ollama just yields an empty
   * list rather than an error), plus system RAM (always available, no
   * external dependency), best-effort GPU utilization via nvidia-smi (see
   * hwMetrics.ts — silently empty on non-NVIDIA machines, the common case
   * for local Ollama), and the active session's context-window usage
   * (last call's FULL prompt incl. cached prefix + reply tokens vs. its configured ceiling — see contextUsage.ts).
   */
  private async buildHwStatus(): Promise<HwStatus> {
    const loaded = await this.loadedModelsCached();
    const snap = this.hwSampler.latest().sampledAtMs ? this.hwSampler.latest() : await this.hwSampler.sampleOnce();
    const cfg = getConfig();
    const active = this.activeSession();
    const lastMetrics = this.activeSessionId ? this.lastMetricsBySession.get(this.activeSessionId) : undefined;
    const maxTokens = active?.numCtxOverride || cfg.numCtx;
    const usedTokens = contextUsedTokens(lastMetrics);
    const mem = snap.memory;
    // `ram` stays populated for older readers: from the accurate sample when we have one, else the legacy os-module approximation.
    const ram = mem ? { usedGB: mem.usedGB, totalGB: mem.totalGB } : getRamStatus();
    // NVIDIA fallback only where the macOS/ioreg path produced nothing (Linux/Windows boxes).
    const nvidia = snap.gpus.length ? [] : await getGpuStatus();
    return {
      loadedModels: loaded.map((m) => ({
        name: m.name,
        sizeGB: Math.round((m.size / 1024 / 1024 / 1024) * 10) / 10,
        vramGB: m.size_vram !== undefined ? Math.round((m.size_vram / 1024 / 1024 / 1024) * 10) / 10 : undefined,
        expiresAt: m.expires_at,
      })),
      ram,
      ...hwFieldsForUi(snap),
      gpu: nvidia.length ? nvidia : undefined,
      contextWindow: usedTokens !== undefined ? { usedTokens, maxTokens } : undefined,
      suggestedNumCtx: estimateSuggestedNumCtx(maxTokens, ram),
    };
  }

  /**
   * Builds and sends the full `init` payload. `target`, when given, sends
   * ONLY to that one webview (used for a newly-opened detached panel's own
   * 'ready' handshake — see openPanel()/handleMessage()'s 'ready' case) so
   * opening a second window onto the same session doesn't also re-push
   * `init` into the sidebar view and reset whatever it was mid-render doing.
   * Without a target, broadcasts to every currently-open webview host (the
   * sidebar view and/or the detached panel, whichever exist) via post() —
   * used for the original single-webview activation path.
   */
  private async sendInit(target?: vscode.Webview) {
    const cfg = getConfig();
    const health = await this.ollama.health();
    let models: { name: string; paramSize?: string }[] = [];
    let chatModel = cfg.chatModel;
    if (cfg.provider === 'mlx') {
      try {
        const list = await this.ollama.listModels();
        models = list.map((m) => ({ name: m.name, paramSize: m.details?.parameter_size }));
        chatModel = cfg.mlxModel || cfg.chatModel;
      } catch (err) {
        logger.warn('listModels failed during init', String(err));
      }
    } else if (health.ok) {
      try {
        const list = await this.ollama.listModels();
        models = list.map((m) => ({ name: m.name, paramSize: m.details?.parameter_size }));
        if (!chatModel) {
          const best = pickBestDefaultModel(list);
          if (best) {
            chatModel = best;
            await setChatModel(best);
          }
        }
      } catch (err) {
        logger.warn('listModels failed during init', String(err));
      }
    }

    // Restore the most-recently-updated OPEN session, or start fresh —
    // closed/archived chats are never auto-restored into the tab strip,
    // only reachable deliberately via the "All chats" browser or search.
    if (this.sessions.size === 0) {
      const persisted = (await this.chatStore.listSessions()).filter((s) => !s.closed);
      if (persisted.length > 0) {
        const session = await this.getOrLoadSession(persisted[0].id);
        if (session) this.activeSessionId = session.id;
      }
      if (!this.activeSessionId) {
        const session = new ChatSession(this.services, (id, m) => this.notify(id, m));
        this.sessions.set(session.id, session);
        this.activeSessionId = session.id;
        await session.runHookOnce('session-start');
      }
    }

    const active = this.activeSession();
    const persistedSummaries = (await this.chatStore.listSessions()).filter((s) => !s.closed);
    const known = new Map(persistedSummaries.map((s) => [s.id, s]));
    for (const s of this.sessions.values()) {
      if (!known.has(s.id)) known.set(s.id, { id: s.id, title: s.title, mode: s.mode, updatedAt: new Date().toISOString() });
    }

    const state: InitState = {
      connected: health.ok,
      connectionError: health.error,
      provider: cfg.provider,
      models,
      chatModel,
      mlxModel: cfg.mlxModel,
      completionModel: cfg.completionModel || chatModel,
      indexStatus: this.workspaceIndex.status(),
      pendingEdits: this.pendingEdits.listSerialized(),
      tabCompletionEnabled: cfg.enableTabCompletion,
      modes: Object.values(MODES).map((m) => ({ id: m.id, label: m.label, description: m.description })),
      skills: await this.skills.loadAll(),
      sessions: [...known.values()],
      activeSession: active
        ? active.toSummaryState()
        : { id: 'none', title: 'New chat', mode: 'agent', model: '', busy: false, history: [], checkpoints: [], taskLedger: [], orchestrationEnabled: false, queue: [] },
      hwStatus: await this.buildHwStatus(),
    };
    if (target) target.postMessage({ type: 'init', state });
    else this.post({ type: 'init', state });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.css'));
    const nonce = genId('nonce');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Forge</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
