import * as vscode from 'vscode';

/** Strongly-typed accessor for the `forge.*` settings, re-read on every call so live edits apply immediately. */
export interface ForgeConfig {
  ollamaBaseUrl: string;
  chatModel: string;
  completionModel: string;
  embeddingModel: string;
  temperature: number;
  maxAgentIterations: number;
  requireApprovalForWrites: boolean;
  requireApprovalForCommands: boolean;
  autoApproveCommands: string[];
  enableTabCompletion: boolean;
  completionDebounceMs: number;
  contextChunkCount: number;
  maxContextFileKB: number;
}

export function getConfig(): ForgeConfig {
  const cfg = vscode.workspace.getConfiguration('forge');
  return {
    ollamaBaseUrl: (cfg.get<string>('ollamaBaseUrl') || 'http://localhost:11434').replace(/\/+$/, ''),
    chatModel: cfg.get<string>('chatModel') || '',
    completionModel: cfg.get<string>('completionModel') || '',
    embeddingModel: cfg.get<string>('embeddingModel') || 'nomic-embed-text',
    temperature: cfg.get<number>('temperature') ?? 0.2,
    maxAgentIterations: cfg.get<number>('maxAgentIterations') ?? 25,
    requireApprovalForWrites: cfg.get<boolean>('requireApprovalForWrites') ?? true,
    requireApprovalForCommands: cfg.get<boolean>('requireApprovalForCommands') ?? true,
    autoApproveCommands: cfg.get<string[]>('autoApproveCommands') || [],
    enableTabCompletion: cfg.get<boolean>('enableTabCompletion') ?? true,
    completionDebounceMs: cfg.get<number>('completionDebounceMs') ?? 250,
    contextChunkCount: cfg.get<number>('contextChunkCount') ?? 8,
    maxContextFileKB: cfg.get<number>('maxContextFileKB') ?? 200,
  };
}

export async function setChatModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('chatModel', model, vscode.ConfigurationTarget.Global);
}

export async function setCompletionModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('completionModel', model, vscode.ConfigurationTarget.Global);
}
