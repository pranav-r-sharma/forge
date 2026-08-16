import * as vscode from 'vscode';
import { OllamaClient, pickBestCompletionModel, pickBestDefaultModel } from './ollama/client';
import { setChatModel, setCompletionModel, getConfig } from './util/config';
import { PendingEditManager } from './tools/editApply';
import { openDiffForEdit } from './tools/diffContentProvider';
import { WorkspaceIndex } from './indexing/workspaceIndex';
import { logger } from './util/logger';

/** Item "HWD Utilization metrics" — a quick, no-UI-work-required way to see what's currently resident in Ollama and its VRAM footprint (GET /api/ps), for when the composer-footer readout (live tokens/sec, from ChatSession's 'metrics' events) isn't enough. */
export async function showHwStatusCommand(ollama: OllamaClient) {
  const health = await ollama.health();
  if (!health.ok) {
    vscode.window.showErrorMessage(`Forge: can't reach Ollama (${health.error}).`);
    return;
  }
  const loaded = await ollama.ps();
  if (loaded.length === 0) {
    vscode.window.showInformationMessage('Forge: no models currently loaded in Ollama (nothing resident right now — send a message to load one).');
    return;
  }
  const lines = loaded.map((m) => {
    const sizeGB = (m.size / 1024 / 1024 / 1024).toFixed(1);
    const vramGB = m.size_vram !== undefined ? ` · ${(m.size_vram / 1024 / 1024 / 1024).toFixed(1)}GB VRAM` : '';
    const until = m.expires_at ? ` · keep-alive until ${new Date(m.expires_at).toLocaleTimeString()}` : '';
    return `${m.name} — ${sizeGB}GB${vramGB}${until}`;
  });
  vscode.window.showInformationMessage(`Forge — loaded models:\n${lines.join('\n')}`, { modal: true });
}

export async function selectChatModelCommand(ollama: OllamaClient) {
  const health = await ollama.health();
  if (!health.ok) {
    vscode.window.showErrorMessage(`Forge: can't reach Ollama (${health.error}). Run "ollama serve" and try again.`);
    return;
  }
  const models = await ollama.listModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage('Forge: no models found. Pull one first, e.g. "ollama pull qwen2.5-coder".');
    return;
  }
  const recommended = pickBestDefaultModel(models);
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.name,
      description: m.details?.parameter_size ? `${m.details.parameter_size}${m.name === recommended ? '  ★ recommended' : ''}` : undefined,
      detail: humanSize(m.size),
    })),
    { title: 'Forge: Select chat / agent model', placeHolder: 'Pick the Ollama model Forge should use for chat and the agent' }
  );
  if (!picked) return;
  await setChatModel(picked.label);
  vscode.window.showInformationMessage(`Forge chat model set to ${picked.label}.`);
}

export async function selectCompletionModelCommand(ollama: OllamaClient) {
  const health = await ollama.health();
  if (!health.ok) {
    vscode.window.showErrorMessage(`Forge: can't reach Ollama (${health.error}).`);
    return;
  }
  const models = await ollama.listModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage('Forge: no models found.');
    return;
  }
  const recommended = pickBestCompletionModel(models);
  const options = [
    { label: '(use chat model)', description: 'Reuse the chat model for Tab autocomplete too' },
    ...models.map((m) => ({
      label: m.name,
      description: m.details?.parameter_size ? `${m.details.parameter_size}${m.name === recommended ? '  ★ recommended (fast)' : ''}` : undefined,
    })),
  ];
  const picked = await vscode.window.showQuickPick(options, {
    title: 'Forge: Select autocomplete model',
    placeHolder: 'Pick a small, fast model for low-latency Tab completions',
  });
  if (!picked) return;
  await setCompletionModel(picked.label === '(use chat model)' ? '' : picked.label);
  vscode.window.showInformationMessage(`Forge autocomplete model set to ${picked.label}.`);
}

export async function checkOllamaStatusCommand(ollama: OllamaClient) {
  const cfg = getConfig();
  const health = await ollama.health();
  if (!health.ok) {
    const choice = await vscode.window.showErrorMessage(
      `Forge can't reach Ollama at ${cfg.ollamaBaseUrl}: ${health.error}`,
      'Open Settings',
      'View Logs'
    );
    if (choice === 'Open Settings') vscode.commands.executeCommand('workbench.action.openSettings', 'forge.ollamaBaseUrl');
    if (choice === 'View Logs') logger.show();
    return;
  }
  const models = await ollama.listModels();
  vscode.window.showInformationMessage(`Forge: connected to Ollama at ${cfg.ollamaBaseUrl}. ${models.length} model(s) available.`);
}

export async function indexWorkspaceCommand(index: WorkspaceIndex) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Forge: indexing workspace for @codebase search', cancellable: true },
    async (progress, token) => {
      let lastFraction = 0;
      await index.build((message, fraction) => {
        progress.report({ message, increment: fraction !== undefined ? Math.max(0, (fraction - lastFraction) * 100) : undefined });
        if (fraction !== undefined) lastFraction = fraction;
      }, token);
    }
  );
  const status = index.status();
  vscode.window.showInformationMessage(
    status.embeddingsAvailable
      ? `Forge: indexed ${status.total} chunks (semantic search enabled).`
      : `Forge: indexed ${status.total} chunks. No embedding model available, so @codebase uses keyword search — pull one with "ollama pull nomic-embed-text" for semantic search.`
  );
}

export async function acceptAllEditsCommand(edits: PendingEditManager) {
  const n = await edits.acceptAll();
  vscode.window.showInformationMessage(`Forge: applied ${n} edit(s).`);
}

export async function rejectAllEditsCommand(edits: PendingEditManager) {
  const n = edits.rejectAll();
  vscode.window.showInformationMessage(`Forge: rejected ${n} edit(s).`);
}

export async function openDiffForFileCommand(edits: PendingEditManager) {
  const pending = edits.listSerialized();
  if (pending.length === 0) {
    vscode.window.showInformationMessage('Forge: no proposed edits are pending review.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    pending.map((e) => ({ label: e.relativePath, description: `+${e.additions} -${e.deletions}`, id: e.id })),
    { title: 'Forge: review a proposed change' }
  );
  if (!picked) return;
  await openDiffForEdit(edits, (picked as any).id);
}

function humanSize(bytes: number): string {
  if (!bytes) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

const RULE_TEMPLATE = `---
description: What this rule is for (shown in tooltips/logs)
globs: ["**/*.ts"]
alwaysApply: false
---

Write your project-specific instructions here — coding conventions, architecture
notes, things the agent should always do or never do in this codebase. This
file is injected into the agent's system prompt whenever the active file
matches one of the globs above, or always if \`alwaysApply: true\`.
`;

const SKILL_TEMPLATE = `---
description: One-line description shown in the / autocomplete list
---

Write the reusable prompt template here. Use {{input}} anywhere you want the
rest of what the user typed after /skillname substituted in; if you don't
use {{input}}, it's appended after this text automatically.
`;

export async function newRuleCommand(workspaceRoot: vscode.Uri) {
  const name = await vscode.window.showInputBox({ title: 'Forge: New Rule', prompt: 'Rule file name (without .md)', value: 'my-rule' });
  if (!name) return;
  const uri = vscode.Uri.joinPath(workspaceRoot, '.forge', 'rules', `${sanitize(name)}.md`);
  await ensureFileWithContent(uri, RULE_TEMPLATE);
  await vscode.window.showTextDocument(uri);
}

export async function newSkillCommand(workspaceRoot: vscode.Uri) {
  const name = await vscode.window.showInputBox({ title: 'Forge: New Skill (/command)', prompt: 'Skill name — invoked as /name in chat', value: 'my-skill' });
  if (!name) return;
  const uri = vscode.Uri.joinPath(workspaceRoot, '.forge', 'skills', `${sanitize(name)}.md`);
  await ensureFileWithContent(uri, SKILL_TEMPLATE);
  await vscode.window.showTextDocument(uri);
}

export async function openHooksFolderCommand(workspaceRoot: vscode.Uri) {
  const dir = vscode.Uri.joinPath(workspaceRoot, '.forge', 'hooks');
  const readme = vscode.Uri.joinPath(dir, 'README.md');
  const exists = await ensureFileWithContent(
    readme,
    `# Forge hooks

Drop an executable script named exactly \`session-start\`, \`before-write\`,
\`after-write\`, \`before-command\`, or \`after-command\` in this folder (any
shebang, e.g. \`#!/usr/bin/env bash\` or \`#!/usr/bin/env node\`, then
\`chmod +x\`) and Forge will run it at that point in the agent loop, passing a
JSON payload on stdin.

\`before-write\` and \`before-command\` are gating hooks: exit non-zero to
block the action (your stdout/stderr becomes the reason shown to the model).
The others are fire-and-forget notifications (logging, Slack pings, etc.).
`
  );
  await vscode.window.showTextDocument(readme);
  if (!exists) vscode.window.showInformationMessage('Forge: created .forge/hooks/README.md with the hook contract — add your scripts alongside it.');
}

async function ensureFileWithContent(uri: vscode.Uri, content: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true; // already exists, leave it alone
  } catch {
    /* doesn't exist yet */
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  return false;
}

function sanitize(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() || 'untitled';
}
