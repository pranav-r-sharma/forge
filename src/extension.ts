import * as vscode from 'vscode';
import * as os from 'os';
import { OllamaClient } from './ollama/client';
import { getConfig } from './util/config';
import { logger } from './util/logger';
import { PendingEditManager } from './tools/editApply';
import { BackgroundProcessManager } from './tools/backgroundProcessManager';
import { DiffContentProvider, FORGE_DIFF_SCHEME } from './tools/diffContentProvider';
import { WorkspaceIndex } from './indexing/workspaceIndex';
import { ChatMemoryIndex } from './indexing/chatMemoryIndex';
import { RulesEngine } from './forge/rules';
import { SkillsEngine } from './forge/skills';
import { HookRunner } from './forge/hooks';
import { MemoryStore } from './forge/memory';
import { ChatStore } from './forge/chatStore';
import { ChatViewProvider } from './chat/chatViewProvider';
import { InlineEditController } from './inlineEdit/inlineEditController';
import { ForgeInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { ForgeStatusBar } from './statusBar';
import { WebSearchKeyStore } from './websearch/keyStore';
import { WebSearchService } from './websearch/searchService';
import { WebFetchService } from './websearch/fetchService';
import { ProviderCredentials } from './websearch/types';
import {
  acceptAllEditsCommand,
  checkOllamaStatusCommand,
  compactMemoryCommand,
  exportAllChatsCommand,
  indexWorkspaceCommand,
  newRuleCommand,
  newSkillCommand,
  openDiffForFileCommand,
  openHooksFolderCommand,
  openMemoryFileCommand,
  openProjectLogCommand,
  openTerminalCommand,
  rejectAllEditsCommand,
  selectChatModelCommand,
  selectCompletionModelCommand,
  setModelForModeCommand,
  setWebSearchApiKeyCommand,
  showHwStatusCommand,
} from './commands';

/** Module-level so deactivate() (a separate top-level function, no closure over activate()'s locals) can reach it to kill any still-running background commands — see BackgroundProcessManager.disposeAll()'s doc comment. */
let activeBackgroundProcesses: BackgroundProcessManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  logger.init(context);
  logger.info('Forge activating…');

  const folder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = folder?.uri ?? vscode.Uri.file(os.homedir());
  const workspaceName = folder?.name ?? '(no folder open)';
  if (!folder) {
    logger.warn('No workspace folder open — file tools, indexing, and the agent will be limited until you open a folder.');
  }

  const ollama = new OllamaClient(() => getConfig().ollamaBaseUrl);
  const pendingEdits = new PendingEditManager(workspaceRoot);
  const backgroundProcesses = new BackgroundProcessManager();
  activeBackgroundProcesses = backgroundProcesses;
  const workspaceIndex = new WorkspaceIndex(ollama, workspaceRoot, context.storageUri, () => getConfig().embeddingModel);
  await workspaceIndex.loadCache();

  const chatMemoryIndex = new ChatMemoryIndex(ollama, context.storageUri, () => getConfig().embeddingModel);
  await chatMemoryIndex.loadCache();

  const rules = new RulesEngine(workspaceRoot);
  const skills = new SkillsEngine(workspaceRoot);
  const hooks = new HookRunner(workspaceRoot);
  const memory = new MemoryStore(workspaceRoot);
  const chatStore = new ChatStore(workspaceRoot);

  // Item "web search": credentials resolve from two places depending on the
  // provider — secret-backed API keys (brave/tavily/google) come from
  // vscode.SecretStorage via WebSearchKeyStore, while SearXNG's instance URL
  // and DuckDuckGo's "no credentials needed" are plain forge.webSearch.*
  // config. This closure is the one place that distinction is resolved, so
  // searchService.ts/fetchService.ts stay agnostic to where a credential
  // actually lives.
  const webSearchKeyStore = new WebSearchKeyStore(context.secrets);
  const getWebSearchCredentials = async (providerId: string): Promise<ProviderCredentials> => {
    if (providerId === 'searxng') return { instanceUrl: getConfig().webSearchSearxngUrl || undefined };
    if (providerId === 'duckduckgo') return {};
    return webSearchKeyStore.get(providerId);
  };
  const webSearchService = new WebSearchService(
    () => {
      const cfg = getConfig();
      return {
        provider: cfg.webSearchProvider,
        maxResults: cfg.webSearchMaxResults,
        timeoutMs: cfg.webSearchTimeoutMs,
        cacheTtlMinutes: cfg.webSearchCacheTtlMinutes,
        blockedDomains: cfg.webSearchBlockedDomains,
      };
    },
    getWebSearchCredentials
  );
  const webFetchService = new WebFetchService(() => {
    const cfg = getConfig();
    return {
      timeoutMs: cfg.webSearchTimeoutMs,
      respectRobotsTxt: cfg.webSearchRespectRobotsTxt,
      maxFetchChars: cfg.webSearchMaxFetchChars,
      cacheTtlMinutes: cfg.webSearchCacheTtlMinutes,
    };
  });

  const chatViewProvider = new ChatViewProvider(
    context,
    ollama,
    pendingEdits,
    backgroundProcesses,
    workspaceIndex,
    chatMemoryIndex,
    rules,
    skills,
    hooks,
    memory,
    chatStore,
    webSearchService,
    webFetchService,
    webSearchKeyStore,
    workspaceRoot,
    workspaceName
  );
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('forge.chatView', chatViewProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  }));

  const diffProvider = new DiffContentProvider(pendingEdits);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(FORGE_DIFF_SCHEME, diffProvider));

  const inlineEdit = new InlineEditController(ollama, context);

  const completionProvider = new ForgeInlineCompletionProvider(ollama);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider)
  );

  const statusBar = new ForgeStatusBar(ollama, context);

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.newChat', () => chatViewProvider.newChat()),
    vscode.commands.registerCommand('forge.focusChat', () => chatViewProvider.focus()),
    vscode.commands.registerCommand('forge.inlineEdit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await inlineEdit.trigger(editor);
    }),
    vscode.commands.registerCommand('forge.acceptInlineEdit', () => inlineEdit.accept()),
    vscode.commands.registerCommand('forge.rejectInlineEdit', () => inlineEdit.reject()),
    vscode.commands.registerCommand('forge.selectChatModel', async () => {
      await selectChatModelCommand(ollama);
      await statusBar.refresh();
    }),
    vscode.commands.registerCommand('forge.selectCompletionModel', () => selectCompletionModelCommand(ollama)),
    vscode.commands.registerCommand('forge.setModelForMode', () => setModelForModeCommand(ollama)),
    vscode.commands.registerCommand('forge.indexWorkspace', async () => {
      await indexWorkspaceCommand(workspaceIndex);
      await chatViewProvider.refreshIndexStatus();
    }),
    vscode.commands.registerCommand('forge.toggleTabCompletion', async () => {
      const cfg = getConfig();
      await vscode.workspace.getConfiguration('forge').update('enableTabCompletion', !cfg.enableTabCompletion, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Forge: Tab autocomplete ${!cfg.enableTabCompletion ? 'enabled' : 'disabled'}.`);
    }),
    vscode.commands.registerCommand('forge.addFileToContext', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) chatViewProvider.addFileToContext(target);
    }),
    vscode.commands.registerCommand('forge.addSelectionToChat', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) chatViewProvider.addSelectionToChat(editor);
    }),
    vscode.commands.registerCommand('forge.acceptAllAgentEdits', () => acceptAllEditsCommand(pendingEdits)),
    vscode.commands.registerCommand('forge.rejectAllAgentEdits', () => rejectAllEditsCommand(pendingEdits)),
    vscode.commands.registerCommand('forge.openDiffForFile', () => openDiffForFileCommand(pendingEdits)),
    vscode.commands.registerCommand('forge.checkOllamaStatus', () => checkOllamaStatusCommand(ollama)),
    vscode.commands.registerCommand('forge.newRule', () => newRuleCommand(workspaceRoot)),
    vscode.commands.registerCommand('forge.newSkill', () => newSkillCommand(workspaceRoot)),
    vscode.commands.registerCommand('forge.openHooksFolder', () => openHooksFolderCommand(workspaceRoot)),
    vscode.commands.registerCommand('forge.showHwStatus', () => showHwStatusCommand(ollama)),
    vscode.commands.registerCommand('forge.openMemory', () => openMemoryFileCommand(memory)),
    vscode.commands.registerCommand('forge.compactMemory', () => compactMemoryCommand(memory)),
    vscode.commands.registerCommand('forge.openProjectLog', () => openProjectLogCommand(chatStore)),
    vscode.commands.registerCommand('forge.setWebSearchApiKey', () => setWebSearchApiKeyCommand(webSearchKeyStore)),
    vscode.commands.registerCommand('forge.openTerminal', () => openTerminalCommand(workspaceRoot)),
    vscode.commands.registerCommand('forge.exportAllChats', () => exportAllChatsCommand(chatStore, context.extension.packageJSON.version))
  );

  // Best-effort background warm-up: don't block activation on network I/O.
  ollama.health().then((health) => {
    if (!health.ok) {
      logger.warn(`Ollama not reachable at startup: ${health.error}`);
    } else {
      logger.info('Ollama reachable at startup.');
    }
  });

  logger.info('Forge activated.');
}

export function deactivate() {
  // Everything else registered in context.subscriptions is disposed
  // automatically — in-memory pending edits are intentionally
  // session-scoped and need no cleanup. Background commands are the one
  // exception: they're real OS child processes (a dev server, a watcher)
  // that would otherwise keep running orphaned after the extension host
  // shuts down or reloads, with no way left to reach them.
  activeBackgroundProcesses?.disposeAll();
}
