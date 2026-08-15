import * as vscode from 'vscode';
import { OllamaClient, pickBestDefaultModel } from '../ollama/client';
import { PendingEditManager } from '../tools/editApply';
import { openDiffForEdit } from '../tools/diffContentProvider';
import { WorkspaceIndex } from '../indexing/workspaceIndex';
import { RulesEngine } from '../forge/rules';
import { SkillsEngine } from '../forge/skills';
import { HookRunner } from '../forge/hooks';
import { ChatStore } from '../forge/chatStore';
import { MODES } from '../agent/modes';
import { getConfig, setChatModel } from '../util/config';
import { genId } from '../util/ids';
import { toRelative } from '../util/paths';
import { logger } from '../util/logger';
import { ChatSession, ChatSessionServices } from './chatSession';
import { ExtensionToWebviewMessage, InitState, WebviewToExtensionMessage } from '../webview/protocol';

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
  private fileListCache: { at: number; files: vscode.Uri[] } | undefined;
  private services: ChatSessionServices;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ollama: OllamaClient,
    private readonly pendingEdits: PendingEditManager,
    private readonly workspaceIndex: WorkspaceIndex,
    private readonly rules: RulesEngine,
    private readonly skills: SkillsEngine,
    private readonly hooks: HookRunner,
    private readonly chatStore: ChatStore,
    private readonly workspaceRoot: vscode.Uri,
    private readonly workspaceName: string
  ) {
    this.services = { ollama, pendingEdits, workspaceIndex, rules, skills, hooks, chatStore, workspaceRoot, workspaceName };
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
    const session = new ChatSession(this.services, (id, msg) => this.notify(id, msg));
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    await session.runHookOnce('session-start');
    this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
    await this.pushSessionsList();
  }

  async refreshIndexStatus() {
    const status = this.workspaceIndex.status();
    this.post({ type: 'indexStatus', ...status });
  }

  /** Forwards session events to the webview only when that session is the one on screen, with one exception (`busy`) so background tabs can show a spinner. */
  private notify(sessionId: string, msg: ExtensionToWebviewMessage) {
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
    const persisted = await this.chatStore.listSessions();
    // Merge in any not-yet-persisted (brand new, empty) open sessions so they show up immediately.
    const known = new Map(persisted.map((s) => [s.id, s]));
    for (const s of this.sessions.values()) {
      if (!known.has(s.id)) known.set(s.id, { id: s.id, title: s.title, mode: s.mode, updatedAt: new Date().toISOString() });
    }
    this.post({ type: 'sessionsList', sessions: [...known.values()], activeId: this.activeSessionId || '' });
  }

  private async getOrLoadSession(id: string): Promise<ChatSession | undefined> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const stored = await this.chatStore.load(id);
    if (!stored) return undefined;
    const session = ChatSession.fromStored(stored, this.services, (sid, msg) => this.notify(sid, msg));
    this.sessions.set(id, session);
    return session;
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
        const session = await this.getOrLoadSession(msg.id);
        if (!session) return;
        this.activeSessionId = session.id;
        this.post({ type: 'sessionSwitched', session: session.toSummaryState() });
        await this.pushSessionsList();
        return;
      }
      case 'closeSession': {
        // "Closing" a tab deletes that chat's history for good — there is no
        // separate "hide but keep" state, so this must remove it from both
        // the in-memory session map AND the on-disk store. Doing only the
        // former left the persisted copy in .forge/chat/index.json, and
        // pushSessionsList()/sendInit() both rebuild their tab list from
        // chatStore.listSessions(), so the "closed" chat reappeared on the
        // very next list refresh. See CHANGELOG for the v2.0.1 fix.
        const wasOnlySession = this.sessions.size <= 1 && (await this.chatStore.listSessions()).length <= 1;
        if (wasOnlySession) {
          this.post({ type: 'toast', level: 'warn', text: "Can't delete your only chat — start a new one first." });
          return;
        }
        this.sessions.get(msg.id)?.stop();
        this.sessions.delete(msg.id);
        await this.chatStore.delete(msg.id);
        if (this.activeSessionId === msg.id) {
          let next: ChatSession | undefined = [...this.sessions.values()][0];
          if (!next) {
            const persisted = await this.chatStore.listSessions();
            if (persisted.length > 0) next = await this.getOrLoadSession(persisted[0].id);
          }
          if (!next) {
            // Nothing left at all — start a fresh chat rather than leaving the UI with no active session.
            next = new ChatSession(this.services, (id, m) => this.notify(id, m));
            this.sessions.set(next.id, next);
          }
          this.activeSessionId = next.id;
          this.post({ type: 'sessionSwitched', session: next.toSummaryState() });
        }
        await this.pushSessionsList();
        this.post({ type: 'toast', level: 'info', text: 'Chat deleted.' });
        return;
      }
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
        const files = await this.queryFiles(msg.query);
        this.post({ type: 'filesResult', query: msg.query, files });
        return;
      }
      case 'openFile': {
        const uri = vscode.Uri.joinPath(this.workspaceRoot, msg.path);
        vscode.window.showTextDocument(uri).then(undefined, () => vscode.window.showWarningMessage(`Could not open ${msg.path}`));
        return;
      }
      case 'toggleTabCompletion':
        await vscode.workspace.getConfiguration('forge').update('enableTabCompletion', msg.enabled, vscode.ConfigurationTarget.Global);
        return;
    }
  }

  private async queryFiles(query: string): Promise<string[]> {
    const now = Date.now();
    if (!this.fileListCache || now - this.fileListCache.at > 15_000) {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,out,build,.next,venv,.venv,__pycache__,coverage,target,.forge}/**',
        5000
      );
      this.fileListCache = { at: now, files };
    }
    const q = query.toLowerCase();
    return this.fileListCache.files.map((u) => toRelative(this.workspaceRoot, u)).filter((p) => (q ? p.toLowerCase().includes(q) : true)).slice(0, 30);
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

    // Restore the most-recently-updated session, or start fresh.
    if (this.sessions.size === 0) {
      const persisted = await this.chatStore.listSessions();
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
    const persistedSummaries = await this.chatStore.listSessions();
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
        : { id: 'none', title: 'New chat', mode: 'agent', model: '', busy: false, history: [] },
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
