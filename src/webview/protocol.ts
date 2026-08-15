import { PendingEditSerialized } from '../agent/types';
import { ForgeMode } from '../agent/modes';
import { SessionSummary } from '../forge/chatStore';

/** Messages/state shared between the extension host (chatViewProvider.ts) and the webview UI (media/webview.js). */

export type UiTranscriptEntry =
  | { kind: 'user'; id: string; text: string; files?: string[] }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; callId: string; tool: string; args: Record<string, any>; status: 'running' | 'done'; ok?: boolean; summary?: string }
  | { kind: 'approval'; id: string; callId: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { kind: 'plan'; id: string; text: string; executed?: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'system'; id: string; text: string };

export interface ModelInfo {
  name: string;
  paramSize?: string;
}

export { ForgeMode };

export interface ModeInfo {
  id: ForgeMode;
  label: string;
  description: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
}

export interface SessionState {
  id: string;
  title: string;
  mode: ForgeMode;
  model: string;
  busy: boolean;
  history: UiTranscriptEntry[];
}

export interface InitState {
  connected: boolean;
  connectionError?: string;
  models: ModelInfo[];
  chatModel: string;
  completionModel: string;
  indexStatus: { indexed: number; total: number; embeddingsAvailable: boolean };
  pendingEdits: PendingEditSerialized[];
  tabCompletionEnabled: boolean;
  modes: ModeInfo[];
  skills: SkillInfo[];
  sessions: SessionSummary[];
  activeSession: SessionState;
}

export type ExtensionToWebviewMessage =
  | { type: 'init'; state: InitState }
  | { type: 'entry'; sessionId: string; entry: UiTranscriptEntry }
  | { type: 'entryUpdate'; sessionId: string; entry: UiTranscriptEntry }
  | { type: 'tokenAppend'; sessionId: string; id: string; text: string }
  | { type: 'pendingEdits'; edits: PendingEditSerialized[] }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'filesResult'; query: string; files: string[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'indexStatus'; indexed: number; total: number; embeddingsAvailable: boolean }
  | { type: 'prefill'; text: string; files?: string[] }
  | { type: 'sessionsList'; sessions: SessionSummary[]; activeId: string }
  | { type: 'sessionSwitched'; session: SessionState }
  | { type: 'skillsList'; skills: SkillInfo[] };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; files?: string[] }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'switchSession'; id: string }
  | { type: 'closeSession'; id: string }
  | { type: 'setMode'; mode: ForgeMode }
  | { type: 'executePlan'; id: string }
  | { type: 'resolveApproval'; callId: string; approved: boolean }
  | { type: 'acceptEdit'; id: string }
  | { type: 'rejectEdit'; id: string }
  | { type: 'acceptAllEdits' }
  | { type: 'rejectAllEdits' }
  | { type: 'openDiff'; id: string }
  | { type: 'selectModel' }
  | { type: 'indexWorkspace' }
  | { type: 'queryFiles'; query: string }
  | { type: 'openFile'; path: string }
  | { type: 'toggleTabCompletion'; enabled: boolean };
