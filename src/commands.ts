import * as vscode from 'vscode';
import { OllamaClient, pickBestCompletionModel, pickBestDefaultModel } from './ollama/client';
import { setChatModel, setCompletionModel, setModelForMode, getConfig } from './util/config';
import { PendingEditManager } from './tools/editApply';
import { openDiffForEdit } from './tools/diffContentProvider';
import { WorkspaceIndex } from './indexing/workspaceIndex';
import { MemoryStore } from './forge/memory';
import { MODES } from './agent/modes';
import { logger } from './util/logger';
import { WebSearchKeyStore, SECRET_BACKED_PROVIDERS, SecretBackedProviderId } from './websearch/keyStore';
import { PROVIDER_MAP } from './websearch/searchService';
import { ChatStore, StoredSession } from './forge/chatStore';
import { McpManager } from './mcp/mcpManager';

/** Item "web search": provider API keys are stored via vscode.SecretStorage, not settings.json — see keyStore.ts for why. This is the interactive entry point (also reachable from the Settings panel's "Set API Key…" button, which just runs this same command). */
export async function setWebSearchApiKeyCommand(keyStore: WebSearchKeyStore) {
  const picked = await vscode.window.showQuickPick(
    SECRET_BACKED_PROVIDERS.map((id) => ({ id, label: PROVIDER_MAP[id].displayName })),
    { title: 'Forge: Set Web Search API Key — which provider?' }
  );
  if (!picked) return;
  const providerId = (picked as unknown as { id: SecretBackedProviderId }).id;
  const displayName = PROVIDER_MAP[providerId].displayName;

  const apiKey = await vscode.window.showInputBox({
    title: `Forge: ${displayName} API key`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'Paste the API key — leave blank and confirm to clear a previously saved key',
  });
  if (apiKey === undefined) return; // user cancelled (Esc) — different from an intentionally empty submission
  if (!apiKey) {
    await keyStore.clear(providerId);
    vscode.window.showInformationMessage(`Forge: cleared the stored ${displayName} credentials.`);
    return;
  }

  if (providerId === 'google') {
    // Google Programmable Search needs a Search Engine ID (cx) alongside the key — see providers/googleCse.ts.
    const cx = await vscode.window.showInputBox({
      title: 'Forge: Google Programmable Search Engine ID (cx)',
      ignoreFocusOut: true,
      placeHolder: 'From your search engine at programmablesearchengine.google.com',
    });
    if (!cx) {
      vscode.window.showWarningMessage('Forge: Google Programmable Search also needs a Search Engine ID (cx) — nothing was saved.');
      return;
    }
    await keyStore.set(providerId, { apiKey, cx });
  } else {
    await keyStore.set(providerId, { apiKey });
  }
  vscode.window.showInformationMessage(`Forge: ${displayName} API key saved (in VS Code's secret storage, not settings.json).`);
}

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

/** Opens (creating if needed) `.forge/memory.md` — the durable-facts half of the memory system. The agent writes to this itself via the `remember` tool; this command is for reading/hand-editing it directly. */
export async function openMemoryFileCommand(memory: MemoryStore) {
  const uri = vscode.Uri.file(memory.fsPath());
  const raw = await memory.readRaw();
  if (!raw) {
    await ensureFileWithContent(
      uri,
      `# Forge memory

One durable fact per line (as a "- " bullet). Injected into every system
prompt for this project — the agent adds to this itself via the \`remember\`
tool when it learns something worth never forgetting, and you can edit it by
hand too. Keep it short: project conventions, explicit preferences,
decisions and why, where things live. If this file starts growing into a
real knowledge base rather than a handful of durable facts, that content
probably belongs in \`.forge/rules/\` instead.
`
    );
  }
  await vscode.window.showTextDocument(uri);
}

/**
 * Item "documentation skill" — opens (creating if needed) `.forge/project-log.md`,
 * the workspace-wide, cross-chat log every chat's system prompt also reads
 * from (see ChatStore.readProjectLogForPrompt()). This command is purely for
 * a human to read/skim it directly; entries themselves are appended
 * automatically after every turn (ChatSession.send()'s finally block) — there's
 * no "add an entry by hand" flow, since the whole point is that it's a
 * mechanically-generated record of what actually happened, not a second
 * place to remember to write things down.
 */
export async function openProjectLogCommand(chatStore: ChatStore) {
  const path = chatStore.projectLogPath();
  const uri = vscode.Uri.file(path);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await ensureFileWithContent(
      uri,
      `# Forge project log

A running, cross-chat record of what's happened in this project — appended to
automatically after every turn in every chat (a one-line mechanically
generated digest, the same one attached to that turn's checkpoint). Every
chat's system prompt reads the most recent entries from this file, so a
brand-new chat isn't starting from zero context about work already done
elsewhere in the project. Not meant to be hand-edited (there's nothing wrong
with doing so, but it'll just get more entries appended below whatever's
here).
`
    );
  }
  await vscode.window.showTextDocument(uri);
}

/**
 * Item "better way to handle memory as things change over time and
 * irrelevant things get stuck in memory which bloats up the prompt" — the
 * deterministic (no LLM call, no surprises) half of the memory-architecture
 * fix. Shows every current fact pre-checked in a multi-select quick-pick;
 * whatever the user leaves CHECKED is kept, anything they uncheck gets
 * archived (not deleted — see MemoryStore.compact()) to
 * `.forge/memory.archive.md`.
 */
export async function compactMemoryCommand(memory: MemoryStore) {
  const facts = await memory.listFacts();
  if (facts.length === 0) {
    vscode.window.showInformationMessage('Forge: memory is already empty — nothing to compact.');
    return;
  }
  const picked: { label: string; picked: boolean }[] | undefined = await vscode.window.showQuickPick(
    facts.map((f) => ({ label: f, picked: true })),
    {
      title: 'Forge: Compact Memory — uncheck facts that are stale or no longer relevant',
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (picked === undefined) return; // cancelled — nothing changed
  const kept = picked.map((p: { label: string; picked: boolean }) => p.label);
  const result = await memory.compact(kept);
  if (result.archived === 0) {
    vscode.window.showInformationMessage('Forge: no facts were unchecked — memory unchanged.');
  } else {
    vscode.window.showInformationMessage(`Forge: archived ${result.archived} fact(s) to .forge/memory.archive.md. ${kept.length} fact(s) kept.`);
  }
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

/** Item "multi-model task routing" — a small model for Tab completion and Ask, a strong one for Agent/Auto/Outcome's actual editing work, a reasoning-tuned one for Plan, without hand-editing forge.modelRouting JSON. */
export async function setModelForModeCommand(ollama: OllamaClient) {
  const health = await ollama.health();
  if (!health.ok) {
    vscode.window.showErrorMessage(`Forge: can't reach Ollama (${health.error}).`);
    return;
  }
  const modePick = await vscode.window.showQuickPick(
    Object.values(MODES).map((m) => ({ label: m.label, description: m.description, id: m.id })),
    { title: 'Forge: Set Model for Mode — which mode?' }
  );
  if (!modePick) return;

  const models = await ollama.listModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage('Forge: no models found. Pull one first, e.g. "ollama pull qwen2.5-coder".');
    return;
  }
  const cfg = getConfig();
  const current = cfg.modelRouting[(modePick as any).id as keyof typeof cfg.modelRouting];
  const options = [
    { label: `(use forge.chatModel — currently "${cfg.chatModel || 'unset'}")`, description: 'Clear any override for this mode', value: '' },
    ...models.map((m) => ({ label: m.name, description: m.details?.parameter_size, value: m.name })),
  ];
  const picked = await vscode.window.showQuickPick(options, {
    title: `Forge: Set Model for ${modePick.label} mode${current ? ` (currently ${current})` : ''}`,
  });
  if (!picked) return;
  await setModelForMode((modePick as any).id, (picked as any).value);
  vscode.window.showInformationMessage(
    (picked as any).value
      ? `Forge: ${modePick.label} mode now uses ${(picked as any).value}.`
      : `Forge: ${modePick.label} mode reverted to the default chat model.`
  );
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

/**
 * Item "ability to interact and use the terminal and run commands via the
 * terminal" (the user-facing half — see tools/backgroundProcessManager.ts
 * for the agent-facing half, background commands). This is deliberately
 * just a real, ordinary VS Code integrated terminal at the workspace root —
 * Forge doesn't try to proxy or intercept anything you type into it, and
 * the agent has no visibility into what you run here (the reverse of
 * run_command, where the agent runs something and you see it). It's a
 * plain convenience for "I want a terminal in this project" without
 * reaching for the terminal panel's own "+" button, and for jumping
 * straight into a shell to poke at something the agent just did/reported.
 * Reuses an existing "Forge" terminal if one's still open rather than
 * piling up a new tab on every click.
 */
export function openTerminalCommand(workspaceRoot: vscode.Uri) {
  const existing = vscode.window.terminals.find((t: vscode.Terminal) => t.name === 'Forge');
  const terminal = existing ?? vscode.window.createTerminal({ name: 'Forge', cwd: workspaceRoot });
  terminal.show();
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

/**
 * Follow-up to "how can you ensure I don't lose chats" — a manual,
 * complete-in-one-shot escape hatch alongside the automatic hardening in
 * ChatStore (validate-before-commit, backup rotation, tiered recovery — see
 * chatStore.ts). Bundles every saved chat, open AND closed/archived, into a
 * single JSON file at a location you choose, so you can keep a copy
 * somewhere Forge itself doesn't control (a synced folder, a git commit,
 * wherever). Deliberately calls chatStore.load(id) rather than reading each
 * `.json` file directly: load() is what runs the corrupted-session recovery
 * hierarchy, so exporting also opportunistically repairs any chat that was
 * sitting in a broken state, before it goes into the bundle.
 */
export async function exportAllChatsCommand(chatStore: ChatStore, forgeVersion: string) {
  const summaries = await chatStore.listSessions();
  if (summaries.length === 0) {
    vscode.window.showInformationMessage('Forge: no saved chats to export.');
    return;
  }

  const sessions: StoredSession[] = [];
  const failed: string[] = [];
  for (const s of summaries) {
    const loaded = await chatStore.load(s.id);
    if (loaded) {
      sessions.push(loaded);
    } else {
      failed.push(s.title || s.id);
    }
  }

  const bundle = { exportedAt: new Date().toISOString(), forgeVersion, sessions };
  const defaultName = `forge-chats-export-${new Date().toISOString().slice(0, 10)}.json`;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
    filters: { JSON: ['json'] },
    title: 'Forge: Export All Chats',
  });
  if (!uri) return;

  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'));

  const base = `Forge: exported ${sessions.length} chat(s) to ${uri.fsPath}.`;
  vscode.window.showInformationMessage(
    failed.length > 0
      ? `${base} ${failed.length} chat(s) could not be loaded even after recovery and were skipped: ${failed.join(', ')}.`
      : base
  );
}

/**
 * "I want them to natively connect to this Agent" — re-spawns every server
 * in `forge.mcp.servers` and re-lists their tools, for after editing that
 * setting or restarting a server that crashed. See mcp/mcpManager.ts.
 */
export async function reloadMcpServersCommand(mcpManager: McpManager) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Forge: reloading MCP servers…' },
    async () => mcpManager.reload()
  );
  const statuses = mcpManager.status();
  const errors = mcpManager.lastStartErrors();
  if (statuses.length === 0) {
    vscode.window.showInformationMessage('Forge: no MCP servers configured (forge.mcp.servers is empty).');
    return;
  }
  const summary = statuses.map((s) => `${s.server}: ${s.connected ? `${s.toolCount} tool(s)` : 'failed to connect'}`).join('; ');
  if (errors.length > 0) {
    vscode.window.showWarningMessage(`Forge: MCP reload — ${summary}. Errors: ${errors.join(' | ')}`);
  } else {
    vscode.window.showInformationMessage(`Forge: MCP reload — ${summary}.`);
  }
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
