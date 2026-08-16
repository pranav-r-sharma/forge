import * as vscode from 'vscode';
import * as os from 'os';
import { OllamaClient } from './ollama/client';
import { getConfig } from './util/config';
import { logger } from './util/logger';
import { PendingEditManager } from './tools/editApply';
import { DiffContentProvider, FORGE_DIFF_SCHEME } from './tools/diffContentProvider';
import { WorkspaceIndex } from './indexing/workspaceIndex';
import { RulesEngine } from './forge/rules';
import { SkillsEngine } from './forge/skills';
import { HookRunner } from './forge/hooks';
import { ChatStore } from './forge/chatStore';
import { ChatViewProvider } from './chat/chatViewProvider';
import { InlineEditController } from './inlineEdit/inlineEditController';
import { ForgeInlineCompletionProvider } from './completion/inlineCompletionProvider';
import { ForgeStatusBar } from './statusBar';
import {
  acceptAllEditsCommand,
  checkOllamaStatusCommand,
  indexWorkspaceCommand,
  newRuleCommand,
  newSkillCommand,
  openDiffForFileCommand,
  openHooksFolderCommand,
  rejectAllEditsCommand,
  selectChatModelCommand,
  selectCompletionModelCommand,
  showHwStatusCommand,
} from './commands';

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
  const workspaceIndex = new WorkspaceIndex(ollama, workspaceRoot, context.storageUri, () => getConfig().embeddingModel);
  await workspaceIndex.loadCache();

  const rules = new RulesEngine(workspaceRoot);
  const skills = new SkillsEngine(workspaceRoot);
  const hooks = new HookRunner(workspaceRoot);
  const chatStore = new ChatStore(workspaceRoot);

  const chatViewProvider = new ChatViewProvider(
    context,
    ollama,
    pendingEdits,
    workspaceIndex,
    rules,
    skills,
    hooks,
    chatStore,
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
    vscode.commands.registerCommand('forge.showHwStatus', () => showHwStatusCommand(ollama))
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
  // Nothing to clean up beyond what's registered in context.subscriptions —
  // in-memory pending edits are intentionally session-scoped.
}
