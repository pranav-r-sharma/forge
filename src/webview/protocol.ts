import { PendingEditSerialized } from '../agent/types';
import { ForgeMode } from '../agent/modes';
import { SessionSummary } from '../forge/chatStore';
import { OllamaCallMetrics } from '../ollama/types';
import { FileSearchEntry } from '../util/fileSearch';

/** Messages/state shared between the extension host (chatViewProvider.ts) and the webview UI (media/webview.js). */

export type UiTranscriptEntry =
  | { kind: 'user'; id: string; text: string; files?: string[]; checkpointId?: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; unverifiedClaims?: string[] }
  | { kind: 'tool'; id: string; callId: string; tool: string; args: Record<string, any>; status: 'running' | 'done'; ok?: boolean; summary?: string }
  | { kind: 'approval'; id: string; callId: string; detail: string; status: 'pending' | 'approved' | 'denied' }
  | { kind: 'plan'; id: string; text: string; executed?: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'verify'; id: string; command: string; status: 'running' | 'done'; ok?: boolean; summary?: string };

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

export interface CheckpointInfo {
  id: string;
  label: string;
  createdAt: string;
}

export interface SessionState {
  id: string;
  title: string;
  mode: ForgeMode;
  model: string;
  busy: boolean;
  history: UiTranscriptEntry[];
  checkpoints: CheckpointInfo[];
  /** Optional "definition of done" command — see modes.ts's modeSupportsVerifyCommand. */
  verifyCommand?: string;
}

export interface SearchResultItem {
  sessionId: string;
  sessionTitle: string;
  entryId: string;
  snippet: string;
}

/** HW utilization readout for the status bar / composer footer (item "HWD Utilization metrics"). */
export interface HwStatus {
  lastCallMetrics?: OllamaCallMetrics;
  loadedModels: { name: string; sizeGB: number; vramGB?: number; expiresAt?: string }[];
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
  hwStatus: HwStatus;
}

export type ExtensionToWebviewMessage =
  | { type: 'init'; state: InitState }
  | { type: 'entry'; sessionId: string; entry: UiTranscriptEntry }
  | { type: 'entryUpdate'; sessionId: string; entry: UiTranscriptEntry }
  | { type: 'tokenAppend'; sessionId: string; id: string; text: string }
  | { type: 'pendingEdits'; edits: PendingEditSerialized[] }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'filesResult'; query: string; results: FileSearchEntry[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'indexStatus'; indexed: number; total: number; embeddingsAvailable: boolean }
  | { type: 'prefill'; text: string; files?: string[] }
  | { type: 'sessionsList'; sessions: SessionSummary[]; activeId: string }
  | { type: 'sessionSwitched'; session: SessionState }
  | { type: 'skillsList'; skills: SkillInfo[] }
  | { type: 'hwStatus'; status: HwStatus }
  | { type: 'metricsUpdate'; sessionId: string; metrics: OllamaCallMetrics }
  | { type: 'checkpointRestored'; sessionId: string; message: string; ok: boolean }
  | { type: 'searchResults'; query: string; results: SearchResultItem[] };

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
  | { type: 'toggleTabCompletion'; enabled: boolean }
  | { type: 'restoreCheckpoint'; id: string }
  | { type: 'searchChats'; query: string }
  | { type: 'refreshHwStatus' }
  | { type: 'setVerifyCommand'; command: string };
