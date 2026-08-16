import * as vscode from 'vscode';
import { ForgeMode } from '../agent/modes';

/** Strongly-typed accessor for the `forge.*` settings, re-read on every call so live edits apply immediately. */
export interface ForgeConfig {
  ollamaBaseUrl: string;
  chatModel: string;
  completionModel: string;
  embeddingModel: string;
  temperature: number;
  maxAgentIterations: number;
  autoModeMaxIterations: number;
  requireApprovalForWrites: boolean;
  requireApprovalForCommands: boolean;
  autoApproveCommands: string[];
  enableTabCompletion: boolean;
  completionDebounceMs: number;
  contextChunkCount: number;
  maxContextFileKB: number;
  numCtx: number;
  keepAliveMinutes: number;
  /** Per-mode model overrides (Agent/Ask/Plan/Auto/Outcome) — see resolveModelForMode(). An empty/missing entry for a mode falls back to `chatModel`. */
  modelRouting: Partial<Record<ForgeMode, string>>;
  /** Model tag used for spawn_subagent turns (item "sub agents"). Empty = reuse whatever model the spawning turn itself is using. */
  subAgentModel: string;
  /** Tool-call step cap for a single spawn_subagent turn — deliberately its own, tighter budget than forge.autoModeMaxIterations so a sub-task can't silently run forever. */
  subAgentMaxIterations: number;
  /** Maximum spawn_subagent nesting depth (a sub-agent spawning a sub-agent, etc.) — clamped server-side to a small hard ceiling regardless of this value (see agentLoop.ts's HARD_MAX_SUBAGENT_DEPTH). */
  maxSubAgentDepth: number;
  /** Whether to show the brief "Reading foo.ts…" / "Thinking with <model>…" activity line in the composer footer while the agent works. */
  showStatusMessages: boolean;
}

export function getConfig(): ForgeConfig {
  const cfg = vscode.workspace.getConfiguration('forge');
  return {
    ollamaBaseUrl: (cfg.get<string>('ollamaBaseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
    chatModel: cfg.get<string>('chatModel') || '',
    completionModel: cfg.get<string>('completionModel') || '',
    embeddingModel: cfg.get<string>('embeddingModel') || 'nomic-embed-text',
    temperature: cfg.get<number>('temperature') ?? 0.2,
    // 25 was the only safety net against a thrashing/looping task; the loop
    // detector (agent/loopDetector.ts) is now the real safety net, so this
    // can be a much more generous default without silently truncating a
    // legitimately long task. Auto mode uses its own, far larger cap below.
    maxAgentIterations: cfg.get<number>('maxAgentIterations') ?? 200,
    autoModeMaxIterations: cfg.get<number>('autoModeMaxIterations') ?? 100000,
    requireApprovalForWrites: cfg.get<boolean>('requireApprovalForWrites') ?? true,
    requireApprovalForCommands: cfg.get<boolean>('requireApprovalForCommands') ?? true,
    autoApproveCommands: cfg.get<string[]>('autoApproveCommands') || [],
    enableTabCompletion: cfg.get<boolean>('enableTabCompletion') ?? true,
    completionDebounceMs: cfg.get<number>('completionDebounceMs') ?? 250,
    contextChunkCount: cfg.get<number>('contextChunkCount') ?? 8,
    maxContextFileKB: cfg.get<number>('maxContextFileKB') ?? 200,
    // 0 = let Ollama use its own (small, often silently-truncating) default.
    // Set this to your model's real max (check `ollama show <model>`) to stop
    // long agent sessions from quietly losing early context.
    numCtx: cfg.get<number>('numCtx') ?? 32768,
    // -1 = never unload the model between messages (avoids paying a full
    // reload + KV-cache-rebuild cost every time you pause to think).
    // 0 = server default (~5 min idle unload).
    keepAliveMinutes: cfg.get<number>('keepAliveMinutes') ?? -1,
    modelRouting: cfg.get<Partial<Record<ForgeMode, string>>>('modelRouting') || {},
    subAgentModel: cfg.get<string>('subAgentModel') || '',
    subAgentMaxIterations: cfg.get<number>('subAgentMaxIterations') ?? 40,
    maxSubAgentDepth: cfg.get<number>('maxSubAgentDepth') ?? 2,
    showStatusMessages: cfg.get<boolean>('showStatusMessages') ?? true,
  };
}

export async function setChatModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('chatModel', model, vscode.ConfigurationTarget.Global);
}

export async function setCompletionModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('completionModel', model, vscode.ConfigurationTarget.Global);
}

/**
 * Keys the in-webview Settings panel (item "a new setting pane") is allowed
 * to write directly via a generic {key, value} message, instead of needing a
 * bespoke message type + handler per setting. Deliberately an allowlist —
 * anything not in this set is rejected by setForgeSetting() so a webview
 * message can never blind-write an arbitrary VS Code setting.
 */
export const SETTINGS_PANEL_KEYS = [
  'numCtx',
  'temperature',
  'requireApprovalForWrites',
  'requireApprovalForCommands',
  'keepAliveMinutes',
  'subAgentModel',
  'subAgentMaxIterations',
  'maxSubAgentDepth',
  'showStatusMessages',
] as const;
export type SettingsPanelKey = (typeof SETTINGS_PANEL_KEYS)[number];

/** Generic setting writer backing the Settings panel — see SETTINGS_PANEL_KEYS. */
export async function setForgeSetting(key: string, value: unknown): Promise<boolean> {
  if (!(SETTINGS_PANEL_KEYS as readonly string[]).includes(key)) return false;
  await vscode.workspace.getConfiguration('forge').update(key, value, vscode.ConfigurationTarget.Global);
  return true;
}

/** Sets (or clears, with model === '') the model routed to one specific mode — see forge.modelRouting and resolveModelForMode(). */
export async function setModelForMode(mode: ForgeMode, model: string) {
  const cfg = vscode.workspace.getConfiguration('forge');
  const routing = { ...(cfg.get<Partial<Record<ForgeMode, string>>>('modelRouting') || {}) };
  if (model) routing[mode] = model;
  else delete routing[mode];
  await cfg.update('modelRouting', routing, vscode.ConfigurationTarget.Global);
}

/**
 * Resolves which model a turn should actually use, in priority order: an
 * explicit per-session override (the user picked one for this chat tab)
 * beats per-mode routing (this mode always uses a specific model) beats the
 * single global default. Tab completion and the embedding model stay on
 * their own separate settings — they were never part of the one-model
 * compromise this exists to fix.
 */
export function resolveModelForMode(mode: ForgeMode, sessionOverride: string, cfg: ForgeConfig): string {
  return sessionOverride || cfg.modelRouting[mode] || cfg.chatModel;
}
