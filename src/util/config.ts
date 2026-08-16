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
  };
}

export async function setChatModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('chatModel', model, vscode.ConfigurationTarget.Global);
}

export async function setCompletionModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('completionModel', model, vscode.ConfigurationTarget.Global);
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
