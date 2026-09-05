// Runtime tests for the 0.12.0 detached-panel UI (item 3: "a Claude
// Code-like extension UI which opens separate from the file
// explorer/extension pane"). Exercises ChatViewProvider.openPanel() and its
// interaction with the existing sidebar WebviewView host — both should be
// live, independent windows onto the SAME shared session state (post()
// broadcasts to both; a webview's own 'ready' handshake only ever targets
// that one webview, never re-initializing the other). No real VS Code
// window is available in this sandboxed runtime, so vscode.window.
// createWebviewPanel is monkey-patched with a fake panel object — same
// "fake the one seam we need, exercise everything behind it for real"
// technique test_v7.ts already uses for the sidebar's `view`.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ChatStore } from '../../src/forge/chatStore';
import { ChatViewProvider } from '../../src/chat/chatViewProvider';
import { OllamaClient } from '../../src/ollama/client';
import { PendingEditManager } from '../../src/tools/editApply';
import { WorkspaceIndex } from '../../src/indexing/workspaceIndex';
import { ChatMemoryIndex } from '../../src/indexing/chatMemoryIndex';
import { RulesEngine } from '../../src/forge/rules';
import { SkillsEngine } from '../../src/forge/skills';
import { HookRunner } from '../../src/forge/hooks';
import { MemoryStore } from '../../src/forge/memory';
import { WebSearchService } from '../../src/websearch/searchService';
import { WebFetchService } from '../../src/websearch/fetchService';
import { WebSearchKeyStore } from '../../src/websearch/keyStore';
import { McpManager } from '../../src/mcp/mcpManager';
import { BackgroundProcessManager } from '../../src/tools/backgroundProcessManager';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-panel-test-'));
  return vscode.Uri.file(tmp);
}

function fakeWebview() {
  const posted: any[] = [];
  let readyHandler: ((msg: any) => any) | undefined;
  return {
    posted,
    webview: {
      postMessage: (m: any) => posted.push(m),
      asWebviewUri: (uri: any) => uri,
      cspSource: 'fake-csp:',
      onDidReceiveMessage: (fn: (msg: any) => any) => {
        readyHandler = fn;
        return { dispose: () => {} };
      },
    },
    get onReceive() {
      return readyHandler;
    },
  };
}

async function main() {
  const workspaceRoot = freshWorkspace();
  const ollama = new OllamaClient(() => 'http://localhost:11434');
  const pendingEdits = new PendingEditManager(workspaceRoot);
  const chatStore = new ChatStore(workspaceRoot);
  const workspaceIndex = new WorkspaceIndex(ollama, workspaceRoot, workspaceRoot, () => 'nomic-embed-text', () => new Set());
  const chatMemoryIndex = new ChatMemoryIndex(ollama, workspaceRoot, () => 'nomic-embed-text');
  const rules = new RulesEngine(workspaceRoot);
  const skills = new SkillsEngine(workspaceRoot);
  const hooks = new HookRunner(workspaceRoot);
  const memory = new MemoryStore(workspaceRoot);
  const keyStore = new WebSearchKeyStore({ get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) } as any);
  const webSearchService = new WebSearchService(() => ({ provider: 'auto', maxResults: 5, timeoutMs: 5000, cacheTtlMinutes: 10, blockedDomains: [] }), async () => ({}));
  const webFetchService = new WebFetchService(() => ({ timeoutMs: 5000, respectRobotsTxt: true, maxFetchChars: 5000, cacheTtlMinutes: 10 }));
  const mcpManager = new McpManager(() => []);

  const fakeContext: any = {
    subscriptions: [],
    extensionUri: workspaceRoot,
    extensionPath: workspaceRoot.fsPath,
    storageUri: workspaceRoot,
    globalStorageUri: workspaceRoot,
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
  };

  const provider: any = new ChatViewProvider(
    fakeContext,
    ollama,
    pendingEdits,
    new BackgroundProcessManager(),
    workspaceIndex,
    chatMemoryIndex,
    rules,
    skills,
    hooks,
    memory,
    chatStore,
    webSearchService,
    webFetchService,
    keyStore,
    mcpManager,
    workspaceRoot,
    'test-workspace'
  );

  // ---- sidebar view is "open" (same fake-view technique as test_v7.ts) ----
  const sidebar = fakeWebview();
  provider.view = sidebar;

  // ---- open the detached panel: monkey-patch vscode.window.createWebviewPanel ----
  const vs: any = vscode;
  let createCalls = 0;
  let revealCalls = 0;
  let disposeHandler: (() => void) | undefined;
  const panelHost = fakeWebview();
  const fakePanel: any = {
    webview: panelHost.webview,
    viewColumn: 2,
    iconPath: undefined,
    reveal: () => {
      revealCalls++;
    },
    onDidDispose: (fn: () => void) => {
      disposeHandler = fn;
      return { dispose: () => {} };
    },
    dispose: () => {
      if (disposeHandler) disposeHandler();
    },
  };
  vs.window.createWebviewPanel = (_viewType: string, _title: string, _showOptions: any, _options: any) => {
    createCalls++;
    return fakePanel;
  };

  provider.openPanel();
  ok(createCalls === 1, 'openPanel() calls vscode.window.createWebviewPanel exactly once when no panel is open yet');
  ok(!!panelHost.webview, 'the panel got its own webview.html set via the same getHtml() used by the sidebar (no crash reading webview.asWebviewUri/cspSource)');

  provider.openPanel();
  ok(createCalls === 1 && revealCalls === 1, 'calling openPanel() again while one is already open reveals the existing panel instead of creating a second one (got createCalls=' + createCalls + ', revealCalls=' + revealCalls + ')');

  // ---- 'ready' from the panel targets ONLY the panel, not the sidebar ----
  sidebar.posted.length = 0;
  panelHost.posted.length = 0;
  ok(typeof panelHost.onReceive === 'function', 'the panel wired up an onDidReceiveMessage handler');
  await panelHost.onReceive!({ type: 'ready' });
  ok(panelHost.posted.some((m) => m.type === 'init'), 'the panel receives its own \'init\' state after sending \'ready\'');
  ok(!sidebar.posted.some((m) => m.type === 'init'), 'the sidebar view does NOT get a redundant \'init\' push just because the PANEL sent \'ready\' — a second host opening must not reset the first one\'s already-rendered state');

  // ---- likewise, sidebar's own 'ready' targets only the sidebar ----
  sidebar.posted.length = 0;
  panelHost.posted.length = 0;
  await provider.handleMessage({ type: 'ready' }, sidebar.webview);
  ok(sidebar.posted.some((m) => m.type === 'init'), 'the sidebar receives its own \'init\' state after its own \'ready\'');
  ok(!panelHost.posted.some((m) => m.type === 'init'), 'the panel does NOT get a redundant \'init\' push from the sidebar\'s own \'ready\' handshake');

  // ---- post() (broadcast-style messages) reaches BOTH hosts once both are open ----
  sidebar.posted.length = 0;
  panelHost.posted.length = 0;
  provider.post({ type: 'toast', level: 'info', text: 'broadcast test' });
  ok(sidebar.posted.some((m) => m.type === 'toast'), 'a broadcast post() reaches the sidebar view');
  ok(panelHost.posted.some((m) => m.type === 'toast'), 'the SAME broadcast post() also reaches the detached panel — they are two live views onto one shared session, not two separate chats');

  // ---- disposing the panel clears provider.panel, so a later openPanel() creates a fresh one ----
  fakePanel.dispose();
  ok(provider.panel === undefined, 'onDidDispose clears provider.panel when the user closes the panel\'s tab');
  sidebar.posted.length = 0;
  provider.post({ type: 'toast', level: 'info', text: 'after dispose' });
  ok(sidebar.posted.some((m) => m.type === 'toast'), 'post() still reaches the sidebar after the panel is disposed');
  provider.openPanel();
  ok(createCalls === 2, 'openPanel() creates a NEW panel after the previous one was disposed, rather than trying to reveal a stale reference');

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.12.0 detached-panel runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
