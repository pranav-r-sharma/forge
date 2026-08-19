import * as vscode from 'vscode';
import { OllamaClient, pickBestDefaultModel } from '../ollama/client';
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
import { MODES } from '../agent/modes';
import { getConfig, setChatModel, setForgeSetting } from '../util/config';
import { genId } from '../util/ids';
import { toRelative } from '../util/paths';
import { WorkspaceEntryIndex } from '../util/fileSearch';
import { estimateSuggestedNumCtx, getGpuStatus, getRamStatus } from '../util/hwMetrics';
import { logger } from '../util/logger';
import { ChatSession, ChatSessionServices } from './chatSession';
import { ExtensionToWebviewMessage, HwStatus, InitState, SearchResultItem, SettingsSnapshot, UiTranscriptEntry, WebviewToExtensionMessage } from '../webview/protocol';
import { OllamaCallMetrics } from '../ollama/types';

/**
 * Thin webview host + multi-session ("multitask") manager. All the actual
 * agent-turn logic lives in ChatSession; this class owns which sessions are
 * open, which one is currently shown in the webview, and the workspace-wide
 * shared services every session draws on (Ollama client, pending edits,
 * workspace index, rules/skills/hooks).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ollama: OllamaClient,
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
    private readonly workspaceRoot: vscode.Uri,
    private readonly workspaceName: string
  ) {
    this.services = { ollama, pendingEdits, backgroundProcesses, workspaceIndex, chatMemoryIndex, rules, skills, hooks, memory, chatStore, webSearchService, webFetchService, workspaceRoot, workspaceName };
    this.entryIndex = new WorkspaceEntryIndex(workspaceRoot);
    this.pendingEdits.onDidChange((edits) => this.post({ type: 'pendingEdits', edits }));
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => this.handleMessage(msg));
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
  }

  focus() {
    this.view?.show?.(true);
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

  async refreshIndexStatus() {
    const status = this.workspaceIndex.status();
    this.post({ type: 'indexStatus', ...status });
  }

  /** Forwards session events to the webview only when that session is the one on screen, with one exception (`busy`) so background tabs can show a spinner. */
  private notify(sessionId: string, msg: ExtensionToWebviewMessage) {
    if (msg.type === 'metricsUpdate') this.lastMetricsBySession.set(sessionId, msg.metrics);
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

  private post(message: ExtensionToWebviewMessage) {
    this.view?.webview.postMessage(message);
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

  private async handleMessage(msg: WebviewToExtensionMessage) {
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
        return;
      case 'send':
        await this.activeSession()?.send(msg.text, msg.files || []);
        return;
      case 'stop':
        this.activeSession()?.stop();
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
        const uri = vscode.Uri.joinPath(this.workspaceRoot, msg.path);
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
        this.post({ type: 'settingsData', settings: await this.buildSettingsSnapshot() });
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

  /** Snapshot of every setting the in-webview Settings panel can read/write — see util/config.ts's SETTINGS_PANEL_KEYS. Async because provider-configured status reads vscode.SecretStorage. */
  private async buildSettingsSnapshot(): Promise<SettingsSnapshot> {
    const cfg = getConfig();
    const webSearchProviders = await Promise.all(
      PROVIDERS.map(async (p) => {
        if (p.id === 'searxng') return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: !!cfg.webSearchSearxngUrl };
        if (!p.requiresApiKey) return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: true };
        const creds = await this.keyStore.get(p.id);
        return { id: p.id, displayName: p.displayName, requiresApiKey: p.requiresApiKey, configured: p.isConfigured(creds) };
      })
    );
    return {
      numCtx: cfg.numCtx,
      temperature: cfg.temperature,
      requireApprovalForWrites: cfg.requireApprovalForWrites,
      requireApprovalForCommands: cfg.requireApprovalForCommands,
      keepAliveMinutes: cfg.keepAliveMinutes,
      subAgentModel: cfg.subAgentModel,
      subAgentMaxIterations: cfg.subAgentMaxIterations,
      maxSubAgentDepth: cfg.maxSubAgentDepth,
      showStatusMessages: cfg.showStatusMessages,
      webSearchEnabled: cfg.webSearchEnabled,
      webSearchProvider: cfg.webSearchProvider,
      webSearchMaxResults: cfg.webSearchMaxResults,
      webSearchRespectRobotsTxt: cfg.webSearchRespectRobotsTxt,
      webSearchSearxngUrl: cfg.webSearchSearxngUrl,
      webSearchProviders,
    };
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
   * (last call's prompt+eval token count vs. its configured ceiling).
   */
  private async buildHwStatus(): Promise<HwStatus> {
    const [loaded, gpu] = await Promise.all([this.ollama.ps().catch(() => []), getGpuStatus()]);
    const cfg = getConfig();
    const active = this.activeSession();
    const lastMetrics = this.activeSessionId ? this.lastMetricsBySession.get(this.activeSessionId) : undefined;
    const maxTokens = active?.numCtxOverride || cfg.numCtx;
    const usedTokens = lastMetrics ? (lastMetrics.promptTokens || 0) + (lastMetrics.evalTokens || 0) : undefined;
    const ram = getRamStatus();
    return {
      loadedModels: loaded.map((m) => ({
        name: m.name,
        sizeGB: Math.round((m.size / 1024 / 1024 / 1024) * 10) / 10,
        vramGB: m.size_vram !== undefined ? Math.round((m.size_vram / 1024 / 1024 / 1024) * 10) / 10 : undefined,
        expiresAt: m.expires_at,
      })),
      ram,
      gpu: gpu.length ? gpu : undefined,
      contextWindow: usedTokens !== undefined ? { usedTokens, maxTokens } : undefined,
      suggestedNumCtx: estimateSuggestedNumCtx(maxTokens, ram),
    };
  }

  private async sendInit() {
    const cfg = getConfig();
    const health = await this.ollama.health();
    let models: { name: string; paramSize?: string }[] = [];
    let chatModel = cfg.chatModel;
    if (health.ok) {
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
      models,
      chatModel,
      completionModel: cfg.completionModel || chatModel,
      indexStatus: this.workspaceIndex.status(),
      pendingEdits: this.pendingEdits.listSerialized(),
      tabCompletionEnabled: cfg.enableTabCompletion,
      modes: Object.values(MODES).map((m) => ({ id: m.id, label: m.label, description: m.description })),
      skills: await this.skills.loadAll(),
      sessions: [...known.values()],
      activeSession: active
        ? active.toSummaryState()
        : { id: 'none', title: 'New chat', mode: 'agent', model: '', busy: false, history: [], checkpoints: [] },
      hwStatus: await this.buildHwStatus(),
    };
    this.post({ type: 'init', state });
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
