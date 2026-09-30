import { AgentActivity, PendingEditSerialized, ToolResultAttachment } from '../agent/types';
import { ForgeMode } from '../agent/modes';
import { TaskLedgerEntry } from '../agent/taskLedger';
import { SessionSummary } from '../forge/chatStore';
import { OllamaCallMetrics } from '../ollama/types';
import { FileSearchEntry } from '../util/fileSearch';

/** Messages/state shared between the extension host (chatViewProvider.ts) and the webview UI (media/webview.js). */

export type UiTranscriptEntry =
  | { kind: 'user'; id: string; text: string; files?: string[]; checkpointId?: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; unverifiedClaims?: string[] }
  /** `attachments` — MCP standardization (0.14.0): non-text content blocks (images, embedded resources) an MCP tool's result carried, shown on the card instead of inlined into `summary` — see agent/types.ts's ToolResultAttachment. Absent for built-in tools and for MCP tools that only returned text. */
  | { kind: 'tool'; id: string; callId: string; tool: string; args: Record<string, any>; status: 'running' | 'done'; ok?: boolean; summary?: string; attachments?: ToolResultAttachment[] }
  /** `reviewKind` distinguishes what's being approved — 'command' (the original, default) or, new for cost-aware task planning, 'plan_review' (see ApprovalBroker.requestPlanApproval/agent/taskCost.ts). Optional so old, already-persisted sessions from before 'plan_review' existed still deserialize as the 'command' rendering. */
  | { kind: 'approval'; id: string; callId: string; detail: string; status: 'pending' | 'approved' | 'denied'; reviewKind?: 'command' | 'plan_review' }
  | { kind: 'plan'; id: string; text: string; executed?: boolean }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'system'; id: string; text: string }
  /** Generic advisory banner. `details` (per-file findings) is specific to the Outcome-mode gaming-detection scenario (agent/gamingDetection.ts) that first used this — optional so a simpler advisory (e.g. cost-aware task planning's AgentEvent 'tool_warning', agent/taskCost.ts) can use the same kind without fabricating an empty array. Advisory either way, never an error: the turn still completed, this is a "double-check this" flag, not a failure. */
  | { kind: 'warning'; id: string; text: string; details?: { path: string; reason: string }[] }
  | { kind: 'verify'; id: string; command: string; status: 'running' | 'done'; ok?: boolean; summary?: string }
  | { kind: 'subagent'; id: string; task: string; status: 'running' | 'done'; ok?: boolean; summary?: string; depth: number };

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
  /** Mechanically-generated one-line digest of that turn — see chat/milestones.ts. Absent if the turn hasn't finished yet. */
  milestone?: string;
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
  /** Per-chat context-window override — see ChatSession.numCtxOverride. undefined = use the global forge.numCtx default. */
  numCtxOverride?: number;
  /** Mandatory checkpoint-progress framework (item 4a/4b) — see agent/taskLedger.ts. Always present (possibly empty) so the UI can render a progress panel whenever there's something to show, without a separate "does this chat even have a ledger" round-trip. */
  taskLedger: TaskLedgerEntry[];
  /** Orchestration-mode toggle (item 4c) — see ChatSession.orchestrationEnabled. */
  orchestrationEnabled: boolean;
}

/** Snapshot of the settings the in-webview Settings panel can read/write (item "a new setting pane") — see util/config.ts's SETTINGS_PANEL_KEYS. */
export interface SettingsSnapshot {
  numCtx: number;
  maxAgentIterations: number;
  autoModeMaxIterations: number;
  temperature: number;
  requireApprovalForWrites: boolean;
  requireApprovalForCommands: boolean;
  keepAliveMinutes: number;
  subAgentModel: string;
  subAgentMaxIterations: number;
  maxSubAgentDepth: number;
  showStatusMessages: boolean;
  loopDetectionEnabled: boolean;
  structuredOutputEnabled: boolean;
  planFirstEnabled: boolean;
  requirementsEnabled: boolean;
  requirementsMaxNudges: number;
  requirementsShowInPrompt: boolean;
  selfCritiqueEnabled: boolean;
  bestOfNEnabled: boolean;
  /** Cost-aware task planning (item "cost-aware task planning" — see agent/taskCost.ts). */
  costAwarePlanningEnabled: boolean;
  reviewExpensivePlansEnabled: boolean;
  expensivePlanReviewThreshold: number;
  /** Snapshot of every configured MCP server's connection state — see mcp/mcpManager.ts. */
  mcpStatus: { server: string; connected: boolean; toolCount: number }[];
  webSearchEnabled: boolean;
  webSearchProvider: string;
  webSearchMaxResults: number;
  webSearchRespectRobotsTxt: boolean;
  webSearchSearxngUrl: string;
  /** Every known provider id + display name + whether it currently has usable credentials (a key stored in SecretStorage, or — for SearXNG — a configured instance URL). DuckDuckGo is always "configured" since it needs no credentials. Never includes the actual secret values. */
  webSearchProviders: { id: string; displayName: string; requiresApiKey: boolean; configured: boolean }[];
  mlxPromptCacheGB: number;
  mlxPrefillStepSize: number;
  mlxPromptCacheSize: number;
  mlxDecodeConcurrency: number;
  mlxPromptConcurrency: number;
  mlxDraftModel: string;
  mlxNumDraftTokens: number;
  ollamaNumBatch: number;
  maxContextFileKB: number;
  singleMessageSharePct: number;
  maxOutputTokens: number;
  maxOutputTokensCeiling: number;
  /** Dynamic suggestions from util/recommendations.ts (recomputed on panel open / Refresh). */
  recommendations: SettingRecommendation[];
  /** Short read-only summary of the machine profile used for recommendations. */
  machineProfileSummary?: string;
}

export interface SettingRecommendation {
  settingKey: string;
  recommended: number;
  reason: string;
}

/** Item "ability to kill commands while they are running from the chat window" — see tools/backgroundProcessManager.ts. */
export interface BackgroundCommandInfo {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  startedAt: string;
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
  /** Most recent call's context-window usage vs. the active chat's configured ceiling (session override or forge.numCtx) — see item "context usage metrics". Undefined until at least one call has completed. */
  contextWindow?: { usedTokens: number; maxTokens: number };
  /** System RAM, best-effort via os.totalmem()/os.freemem() — always available (no external dependency). */
  ram?: { usedGB: number; totalGB: number };
  /** GPU utilization/VRAM, best-effort via `nvidia-smi` — absent entirely on machines without an NVIDIA GPU or without nvidia-smi on PATH (e.g. Apple Silicon, AMD), which is the common case for a local-Ollama setup and not an error. */
  gpu?: { name: string; usedVramGB: number; totalVramGB: number; utilizationPct: number }[];
  /**
   * Accurate memory readout (v0.15.0 §1.4, src/util/hwSampler.ts). On macOS: Activity-Monitor-style used/available (NOT os.freemem()), with the OS's own
   * pressure state. `ram` above is kept (and filled from this) for older readers. Undefined → the UI shows "n/a", never a guess.
   */
  memory?: {
    totalGB: number;
    usedGB: number;
    availableGB: number;
    cachedGB: number;
    freeGB: number;
    wiredGB: number;
    compressedGB: number;
    swapUsedGB?: number;
    pressure: 'normal' | 'warn' | 'critical' | 'unknown';
    /** 'darwin' = exact; 'approximate' = non-macOS fallback. */
    source: 'darwin' | 'approximate';
    /** When this reading was taken, so the tooltip can show its age. */
    sampledAtMs: number;
  };
  /** Apple-silicon/Intel-Mac GPU via ioreg (no sudo). `avgPct` is smoothed over a few seconds — display that, not the raw instant; `peakPct` is the max since the current turn began. `inUseGB` is unified memory (the same pool as RAM), not separate VRAM. */
  gpus?: { name?: string; cores?: number; utilizationPct: number; avgPct: number; peakPct: number; inUseGB?: number }[];
  /** Rough, RAM-headroom-based suggestion for a larger forge.numCtx — see util/hwMetrics.ts's estimateSuggestedNumCtx(). Undefined if there isn't enough idle RAM to make a suggestion worthwhile. Deliberately NOT a precise/guaranteed-safe figure — see that function's doc comment. */
  suggestedNumCtx?: number;
}

export interface InitState {
  connected: boolean;
  connectionError?: string;
  /** Active LLM runtime — drives MLX-specific UI (e.g. global model picker in Settings). */
  provider: 'ollama' | 'mlx' | 'openai-compatible';
  models: ModelInfo[];
  chatModel: string;
  /** forge.mlx.model (portable repo id); meaningful when provider === 'mlx'. */
  mlxModel: string;
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
  // `seq` guards against two overlapping pushSessionsList()/pushAllChatsList()
  // calls (from different triggers — a foreground tab switch, a background
  // tab's busy event, etc.) delivering their independent async reads out of
  // order: each is stamped when the push is CALLED, and the webview ignores
  // one that arrives with a lower seq than it's already applied, so a
  // slower/staler read can never roll the tab strip back after a fresher one
  // already landed. See chatViewProvider.ts's sessionsListSeq doc comment.
  | { type: 'sessionsList'; seq: number; sessions: SessionSummary[]; activeId: string }
  | { type: 'sessionSwitched'; session: SessionState }
  | { type: 'skillsList'; skills: SkillInfo[] }
  | { type: 'hwStatus'; status: HwStatus }
  | { type: 'metricsUpdate'; sessionId: string; metrics: OllamaCallMetrics }
  | { type: 'checkpointRestored'; sessionId: string; message: string; ok: boolean }
  /** Item "Ability to fork chats" — see ChatSession.forkAt(). ok:false means the checkpoint itself was invalid; sessionId is the ORIGINATING session (the tab the "Fork here" button was clicked in), not the new fork — the new fork's own arrival is a normal sessionSwitched + sessionsList, same as newChat(). */
  | { type: 'chatForked'; sessionId: string; message: string; ok: boolean }
  | { type: 'searchResults'; query: string; results: SearchResultItem[] }
  | { type: 'allChatsList'; seq: number; sessions: SessionSummary[] }
  | { type: 'statusUpdate'; sessionId: string; text: string; activity?: AgentActivity }
  | { type: 'settingsData'; settings: SettingsSnapshot }
  /** Item "doesn't recognize that the mode has changed": a dedicated, always-fired notification so the composer's mode pill can never go stale — see ChatSession.postModeChanged(). */
  | { type: 'modeChanged'; sessionId: string; mode: ForgeMode }
  /** Item "ability to kill commands while they are running from the chat window" — a snapshot of every background command (see tools/backgroundProcessManager.ts), refreshed on request via the 'listBackgroundCommands' message. */
  | { type: 'backgroundCommandsList'; commands: BackgroundCommandInfo[] }
  /** Item 4a/4b: live push whenever the task ledger changes (plan_tasks/update_task/an auto-instrumented spawn_subagent call) — lets a progress panel update immediately instead of only on the next full session switch. */
  | { type: 'taskLedgerUpdate'; sessionId: string; tasks: TaskLedgerEntry[] };

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
  | { type: 'forkChat'; id: string }
  | { type: 'searchChats'; query: string }
  | { type: 'refreshHwStatus' }
  | { type: 'setVerifyCommand'; command: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'listAllChats' }
  | { type: 'renameSession'; id: string; title: string }
  | { type: 'getSettings' }
  | { type: 'refreshSettings' }
  | { type: 'updateSetting'; key: string; value: any }
  | { type: 'setSessionNumCtx'; numCtx: number | null }
  | { type: 'setWebSearchApiKey' }
  | { type: 'clearWebSearchApiKey'; providerId: string }
  /** Item "ability to run separate models in different chats" — sets (empty string clears) this one chat's own model override. See ChatSession.setModelOverride()/resolveModelForMode(). */
  | { type: 'setSessionModel'; model: string }
  /** On MLX, mlx_lm.server runs one model — this sets forge.mlx.model globally (all chats). */
  | { type: 'setMlxModel'; model: string }
  /** Item "ability to kill commands while they are running from the chat window". */
  | { type: 'listBackgroundCommands' }
  | { type: 'killBackgroundCommand'; id: string }
  /** Item 4c: per-chat orchestration-mode toggle — see ChatSession.setOrchestrationEnabled(). */
  | { type: 'setOrchestrationMode'; enabled: boolean };
