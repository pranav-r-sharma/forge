import { parseProviderId } from '../llm/provider';
import * as vscode from 'vscode';
import { ForgeMode } from '../agent/modes';
import { McpServerConfig } from '../mcp/mcpTypes';

/** Strongly-typed accessor for the `forge.*` settings, re-read on every call so live edits apply immediately. */
export interface ForgeConfig {
  /** Which runtime chat/agent uses: 'ollama', 'mlx' (mlx_lm.server, default per P0-15's C1 decision — see PROGRESS.md), or 'openai-compatible'. See llm/factory.ts. */
  provider: 'ollama' | 'mlx' | 'openai-compatible';
  mlxBaseUrl: string;
  /** Local model folder or Hugging Face repo id (already downloaded) the managed MLX server loads. */
  mlxModel: string;
  /** Hugging Face hub cache root (or any folder with models--org--name layout). */
  mlxModelLibraryPath: string;
  /** Extra directories to scan for MLX models (e.g. LM Studio). */
  mlxExtraModelFolders: string[];
  /** Python with mlx-lm installed; empty = ~/.forge/mlx-venv if present, else python3. */
  mlxPythonPath: string;
  /** Start/stop the MLX server automatically (localhost URLs only). */
  mlxAutoStart: boolean;
  /** Cap for the server's in-memory prompt cache, GB (0 = the server's default). */
  mlxPromptCacheGB: number;
  /** mlx_lm.server --prefill-step-size when > 0 (0 = server default). */
  mlxPrefillStepSize: number;
  /** mlx_lm.server --prompt-cache-size when > 0 (0 = server default). */
  mlxPromptCacheSize: number;
  /** mlx_lm.server --decode-concurrency when > 0 (0 = server default). */
  mlxDecodeConcurrency: number;
  /** mlx_lm.server --prompt-concurrency when > 0 (0 = server default). */
  mlxPromptConcurrency: number;
  /** Smaller MLX model for speculative decoding (--draft-model). Empty = off. */
  mlxDraftModel: string;
  /** mlx_lm.server --num-draft-tokens when mlxDraftModel is set (0 = server default). */
  mlxNumDraftTokens: number;
  mlxExtraArgs: string[];
  /** Context window (tokens) for MLX compaction/meter; part of managed server restart key. */
  mlxContextTokens: number;
  /** Ollama options.num_batch per chat request (0 = server default). */
  ollamaNumBatch: number;
  openaiCompatBaseUrl: string;
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
  /** Share of numCtx (percent) for the per-message char cap in the prompt view — see contextManager.singleMessageCapChars(). */
  singleMessageSharePct: number;
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
  /**
   * Item "setting to toggle off loop detection in auto/outcome mode": on by
   * default (the loop detector is a real safety net against a thrashing
   * task), but some legitimately repetitive workflows trip it, so this lets
   * it be switched off entirely. `check_background_command` is exempt from
   * loop detection unconditionally, regardless of this setting — see
   * checkLoop() in agentLoop.ts.
   */
  loopDetectionEnabled: boolean;
  /** Write a per-iteration JSONL trace to .forge/traces/ (sizes/timings/tokens only, no content) — see agent/traceLog.ts. */
  traceEnabled: boolean;
  /** Keep the prompt append-only between deliberate batched compactions, so the runtime's prompt cache stays valid (see agent/contextManager.ts updatePromptView). Off = the old per-step pruning. */
  contextAppendOnly: boolean;
  /** Thinking mode for chat/agent calls on runtimes that support it (MLX): 'default' = the model's own default, 'off' = faster tool steps, 'on' = force. */
  thinking: 'default' | 'off' | 'on' | 'auto';
  /** Output-token limit per model reply (0 = auto: derived from the context window via resolveEffectiveMaxOutputTokens — never the runtime default, which can be 512 on MLX). */
  maxOutputTokens: number;
  /** When maxOutputTokens is auto (0), cap the derived limit at this value (0 = no ceiling). Explicit maxOutputTokens still wins. */
  maxOutputTokensCeiling: number;
  /** Ask the model for one-sentence tool steps and short final answers (generated tokens dominate step time on local models). */
  terseSteps: boolean;
  /** Estimated prompt size (% of the context window) that triggers a batched compaction, and the size it compacts down to. */
  contextHighWaterPct: number;
  contextLowWaterPct: number;

  /**
   * Opt-in structured-output tool calling (see agent/structuredOutput.ts):
   * off by default because this sandbox has no live Ollama server to verify
   * how well constrained decoding actually behaves with Forge's target local
   * models — try it, and turn it back off if it doesn't help your model.
   */
  structuredOutputEnabled: boolean;
  /** Optional internal no-tool "think first" pass at the start of a turn in Agent/Auto/Outcome mode — see agent/planFirst.ts. Off by default: it's an extra full model call on every turn, real latency cost for a real (but not universally needed) accuracy gain. */
  planFirstEnabled: boolean;
  /** Extract and track numbered requirements from the user message; show a checklist in the turn tail and gate premature finals. */
  requirementsEnabled: boolean;
  requirementsMaxNudges: number;
  requirementsShowInPrompt: boolean;
  /** Run a workspace check before accepting a final answer after file edits (auto-detect or custom command). */
  verifyBeforeDone: 'off' | 'auto' | 'custom';
  /** Shell command when forge.verifyBeforeDone is custom. */
  verifyCommand: string;
  verifyTimeoutSec: number;
  contextPinnedUserMaxChars: number;
  /** Optional extra model call after a large/risky edit asking "does this look right" before it's staged — see agent/selfCritique.ts. Off by default, same latency-cost reasoning as planFirstEnabled. */
  selfCritiqueEnabled: boolean;
  /** Minimum combined added+removed lines for an edit to trigger a self-critique pass — see agent/selfCritique.ts's shouldCritique(). */
  selfCritiqueMinLines: number;
  /** Sample N candidates and pick the best for Outcome-mode plan generation / large rewrites (see agent/bestOfN.ts) instead of trusting a single generation. Off by default — N model calls instead of 1 is a real latency/compute cost. */
  bestOfNEnabled: boolean;
  bestOfNSamples: number;

  /**
   * Cost-aware task planning (extends the 0.12.0 mandatory task ledger — see
   * agent/taskCost.ts): estimates each plan_tasks entry's rough cost tier
   * (model-provided, heuristic fallback otherwise) so the ledger can show an
   * aggregate "how big is this plan" figure and, when it crosses
   * expensivePlanReviewThreshold, either pause for approval (non-autonomous
   * modes, reviewExpensivePlansEnabled on) or post a visible non-blocking
   * warning (Auto/Outcome, or reviewExpensivePlansEnabled off). On by
   * default — unlike the opt-in accuracy levers above, this costs no extra
   * model calls (the tier is either something the model already includes in
   * its plan_tasks call, or a free regex heuristic), so there's little
   * reason to default it off.
   */
  costAwarePlanningEnabled: boolean;
  /** Whether an expensive plan actually pauses for approval (in a mode that isn't fully autonomous) rather than just posting the non-blocking warning. On by default, same reasoning as forge.requireApprovalForWrites/Commands defaulting on. */
  reviewExpensivePlansEnabled: boolean;
  /** Weighted plan-cost score (see agent/taskCost.ts's COST_WEIGHTS: cheap=1, moderate=3, expensive=8) at or above which a plan is flagged. Default 8 — roughly "one expensive task" or "several moderate ones." */
  expensivePlanReviewThreshold: number;

  /** Configured MCP servers Forge connects to at startup — each one either spawned locally over stdio or reached over the network via the MCP Streamable HTTP transport, see mcp/mcpManager.ts. Empty by default (no MCP integration unless you add one). */
  mcpServers: McpServerConfig[];

  // ---------- web search (item "a terrific web search tool") ----------
  // Off by default deliberately — this is the one Forge feature that
  // inherently sends data outside your machine (a query has to reach a
  // search provider, fetched pages come from third-party servers). See
  // websearch/types.ts's doc comment.
  webSearchEnabled: boolean;
  /** 'auto' (try configured providers in priority order, falling back to the no-key DuckDuckGo scrape) or a specific provider id. */
  webSearchProvider: string;
  webSearchMaxResults: number;
  webSearchTimeoutMs: number;
  webSearchCacheTtlMinutes: number;
  webSearchBlockedDomains: string[];
  webSearchRespectRobotsTxt: boolean;
  /** Approximate character cap on a single fetched page's raw body before extraction — see WebFetchServiceConfig.maxFetchChars. */
  webSearchMaxFetchChars: number;
  /** Base URL of a self-hosted SearXNG instance (not a secret — see keyStore.ts for why API keys are handled differently). */
  webSearchSearxngUrl: string;

  /**
   * Watch `<workspace>/.agent-bridge/inbox/forge` and run each file as a chat.
   * Off by default: a process that can write the workspace could otherwise start the agent.
   */
  bridgeEnabled: boolean;
  /** Mode for a bridge task that has no `@mode` line and is not continuing a session. */
  bridgeDefaultMode: ForgeMode;
}

export function getConfig(): ForgeConfig {
  const cfg = vscode.workspace.getConfiguration('forge');
  return {
    provider: parseProviderId(cfg.get<string>('provider')),
    mlxBaseUrl: (cfg.get<string>('mlx.baseUrl') || 'http://127.0.0.1:8123').replace(/\/+$/, ''),
    mlxModel: (cfg.get<string>('mlx.model') || '').trim(),
    mlxModelLibraryPath: (() => {
      const v = cfg.get<string>('mlx.modelLibraryPath');
      if (v === undefined || v === null) return '~/.cache/huggingface/hub';
      return String(v).trim();
    })(),
    mlxExtraModelFolders: (cfg.get<string[]>('mlx.extraModelFolders') || []).filter((a) => typeof a === 'string'),
    mlxPythonPath: (cfg.get<string>('mlx.pythonPath') || '').trim(),
    mlxAutoStart: cfg.get<boolean>('mlx.autoStart') ?? true,
    mlxPromptCacheGB: cfg.get<number>('mlx.promptCacheGB') ?? 32,
    mlxPrefillStepSize: Math.max(0, Math.floor(cfg.get<number>('mlx.prefillStepSize') ?? 0)),
    mlxPromptCacheSize: Math.max(0, Math.floor(cfg.get<number>('mlx.promptCacheSize') ?? 0)),
    mlxDecodeConcurrency: Math.max(0, Math.floor(cfg.get<number>('mlx.decodeConcurrency') ?? 0)),
    mlxPromptConcurrency: Math.max(0, Math.floor(cfg.get<number>('mlx.promptConcurrency') ?? 0)),
    mlxDraftModel: (cfg.get<string>('mlx.draftModel') || '').trim(),
    mlxNumDraftTokens: Math.max(0, Math.floor(cfg.get<number>('mlx.numDraftTokens') ?? 0)),
    mlxExtraArgs: (cfg.get<string[]>('mlx.extraArgs') || []).filter((a) => typeof a === 'string'),
    mlxContextTokens: Math.max(0, Math.floor(cfg.get<number>('mlx.contextTokens') ?? 131072)),
    ollamaNumBatch: Math.max(0, Math.floor(cfg.get<number>('ollama.numBatch') ?? 0)),
    openaiCompatBaseUrl: (cfg.get<string>('openaiCompat.baseUrl') || 'http://127.0.0.1:1234').replace(/\/+$/, ''),
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
    contextChunkCount: cfg.get<number>('contextChunkCount') ?? 24,
    maxContextFileKB: cfg.get<number>('maxContextFileKB') ?? 8192,
    singleMessageSharePct: Math.min(80, Math.max(5, cfg.get<number>('singleMessageSharePct') ?? 25)),
    // 0 = let Ollama use its own (small, often silently-truncating) default.
    // Set this to your model's real max (check `ollama show <model>`) to stop
    // long agent sessions from quietly losing early context.
    // Ollama takes the window per request (forge.numCtx); MLX / OpenAI-compatible servers fix it at start-up, so for those it is the
    // separately-configured forge.mlx.contextTokens (used for compaction thresholds and the context meter).
    numCtx: parseProviderId(cfg.get<string>('provider')) === 'ollama' ? cfg.get<number>('numCtx') ?? 131072 : cfg.get<number>('mlx.contextTokens') ?? 131072,
    // -1 = never unload the model between messages (avoids paying a full
    // reload + KV-cache-rebuild cost every time you pause to think).
    // 0 = server default (~5 min idle unload).
    keepAliveMinutes: cfg.get<number>('keepAliveMinutes') ?? -1,
    modelRouting: cfg.get<Partial<Record<ForgeMode, string>>>('modelRouting') || {},
    subAgentModel: cfg.get<string>('subAgentModel') || '',
    subAgentMaxIterations: cfg.get<number>('subAgentMaxIterations') ?? 200,
    maxSubAgentDepth: cfg.get<number>('maxSubAgentDepth') ?? 2,
    showStatusMessages: cfg.get<boolean>('showStatusMessages') ?? true,
    loopDetectionEnabled: cfg.get<boolean>('loopDetection.enabled') ?? true,
    traceEnabled: cfg.get<boolean>('trace.enabled') ?? true,
    contextAppendOnly: cfg.get<boolean>('context.appendOnly') ?? true,
    thinking: ((v) => (v === 'off' || v === 'on' || v === 'auto' || v === 'default' ? v : 'auto'))(cfg.get<string>('thinking')),
    terseSteps: cfg.get<boolean>('terseSteps') ?? true,
    maxOutputTokens: Math.max(0, Math.floor(cfg.get<number>('maxOutputTokens') ?? 0)),
    maxOutputTokensCeiling: Math.max(0, Math.floor(cfg.get<number>('maxOutputTokensCeiling') ?? 0)),
    contextHighWaterPct: cfg.get<number>('context.highWaterPct') ?? 75,
    contextLowWaterPct: cfg.get<number>('context.lowWaterPct') ?? 45,
    structuredOutputEnabled: cfg.get<boolean>('structuredOutput.enabled') ?? false,
    planFirstEnabled: cfg.get<boolean>('planFirst.enabled') ?? false,
    requirementsEnabled: cfg.get<boolean>('requirements.enabled') ?? false,
    requirementsMaxNudges: Math.max(0, Math.floor(cfg.get<number>('requirements.maxNudges') ?? 2)),
    requirementsShowInPrompt: cfg.get<boolean>('requirements.showInPrompt') ?? true,
    verifyBeforeDone: (() => {
      const v = cfg.get<string>('verifyBeforeDone');
      return v === 'off' || v === 'custom' ? v : 'auto';
    })(),
    verifyCommand: (cfg.get<string>('verifyCommand') || '').trim(),
    verifyTimeoutSec: Math.max(30, Math.floor(cfg.get<number>('verifyTimeoutSec') ?? 300)),
    contextPinnedUserMaxChars: Math.max(2000, Math.floor(cfg.get<number>('context.pinnedUserMaxChars') ?? 40_000)),
    selfCritiqueEnabled: cfg.get<boolean>('selfCritique.enabled') ?? false,
    selfCritiqueMinLines: cfg.get<number>('selfCritique.minLines') ?? 40,
    bestOfNEnabled: cfg.get<boolean>('bestOfN.enabled') ?? false,
    bestOfNSamples: cfg.get<number>('bestOfN.samples') ?? 3,
    costAwarePlanningEnabled: cfg.get<boolean>('taskLedger.costAwarePlanning') ?? true,
    reviewExpensivePlansEnabled: cfg.get<boolean>('taskLedger.reviewExpensivePlans') ?? true,
    expensivePlanReviewThreshold: cfg.get<number>('taskLedger.expensivePlanReviewThreshold') ?? 8,
    mcpServers: cfg.get<McpServerConfig[]>('mcp.servers') || [],
    webSearchEnabled: cfg.get<boolean>('webSearch.enabled') ?? false,
    webSearchProvider: cfg.get<string>('webSearch.provider') || 'auto',
    webSearchMaxResults: cfg.get<number>('webSearch.maxResults') ?? 8,
    webSearchTimeoutMs: cfg.get<number>('webSearch.timeoutMs') ?? 15000,
    webSearchCacheTtlMinutes: cfg.get<number>('webSearch.cacheTtlMinutes') ?? 10,
    webSearchBlockedDomains: cfg.get<string[]>('webSearch.blockedDomains') || [],
    webSearchRespectRobotsTxt: cfg.get<boolean>('webSearch.respectRobotsTxt') ?? true,
    webSearchMaxFetchChars: cfg.get<number>('webSearch.maxFetchChars') ?? 2_000_000,
    webSearchSearxngUrl: cfg.get<string>('webSearch.searxngUrl') || '',
    bridgeEnabled: cfg.get<boolean>('bridge.enabled') ?? false,
    bridgeDefaultMode: (() => {
      const v = cfg.get<string>('bridge.defaultMode');
      return v === 'auto' || v === 'ask' || v === 'plan' || v === 'outcome' ? v : 'agent';
    })(),
  };
}

/** Minimum output-token budget before the agent loop compacts or aborts (never call the model with a smaller cap — runtimes omit 0 and fall back to ~512). */
export const MIN_AGENT_OUTPUT_TOKEN_FLOOR = 2048;

/** Headroom reserved so prompt + output never exceeds the context window. */
export function outputTokenSafetyMargin(contextTokens: number): number {
  const ctx = contextTokens > 0 ? contextTokens : 131072;
  return Math.max(1024, Math.floor(ctx * 0.02));
}

/**
 * Effective max output tokens for one model reply.
 * configured=0 means auto: clamp(context − promptTokens − safety, min 4096, max context/2 with optional ceiling).
 * Explicit forge.maxOutputTokens still wins but is clamped to context − promptTokens − safety.
 * Assumes 131072 context when contextTokens<=0.
 */
export function resolveEffectiveMaxOutputTokens(
  configured: number,
  contextTokens: number,
  ceiling = 0,
  promptTokens = 0,
): number {
  const ctx = contextTokens > 0 ? contextTokens : 131072;
  const safety = outputTokenSafetyMargin(ctx);
  const room = Math.max(0, ctx - Math.max(0, promptTokens) - safety);
  const halfCap = Math.floor(ctx / 2);
  let autoUpper = halfCap;
  if (ceiling > 0) autoUpper = Math.min(autoUpper, ceiling);
  const auto = Math.max(4096, Math.min(autoUpper, room));

  if (configured > 0) return Math.min(configured, room);
  return Math.min(auto, room);
}

/** Tokens left in the window for model output after the estimated prompt and safety margin. */
export function outputTokenRoom(contextTokens: number, promptTokens: number): number {
  const ctx = contextTokens > 0 ? contextTokens : 131072;
  const safety = outputTokenSafetyMargin(ctx);
  return Math.max(0, ctx - Math.max(0, promptTokens) - safety);
}

export async function setChatModel(model: string) {
  await vscode.workspace.getConfiguration('forge').update('chatModel', model, vscode.ConfigurationTarget.Global);
}

/** Sets the global MLX model (repo id) and keeps forge.chatModel in sync for routing/display. */
export async function setMlxChatModel(modelId: string) {
  const cfg = vscode.workspace.getConfiguration('forge');
  await cfg.update('mlx.model', modelId, vscode.ConfigurationTarget.Global);
  await cfg.update('chatModel', modelId, vscode.ConfigurationTarget.Global);
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
  'provider',
  'thinking',
  'terseSteps',
  'context.appendOnly',
  'trace.enabled',
  'numCtx',
  'maxAgentIterations',
  'autoModeMaxIterations',
  'temperature',
  'requireApprovalForWrites',
  'requireApprovalForCommands',
  'keepAliveMinutes',
  'subAgentModel',
  'subAgentMaxIterations',
  'maxSubAgentDepth',
  'showStatusMessages',
  'loopDetection.enabled',
  'structuredOutput.enabled',
  'planFirst.enabled',
  'requirements.enabled',
  'requirements.maxNudges',
  'requirements.showInPrompt',
  'verifyBeforeDone',
  'verifyCommand',
  'verifyTimeoutSec',
  'context.pinnedUserMaxChars',
  'selfCritique.enabled',
  'selfCritique.minLines',
  'bestOfN.enabled',
  'bestOfN.samples',
  'taskLedger.costAwarePlanning',
  'taskLedger.reviewExpensivePlans',
  'taskLedger.expensivePlanReviewThreshold',
  'webSearch.enabled',
  'webSearch.provider',
  'webSearch.maxResults',
  'webSearch.respectRobotsTxt',
  'webSearch.searxngUrl',
  'mlx.promptCacheGB',
  'mlx.prefillStepSize',
  'mlx.promptCacheSize',
  'mlx.decodeConcurrency',
  'mlx.promptConcurrency',
  'mlx.draftModel',
  'mlx.numDraftTokens',
  'ollama.numBatch',
  'maxContextFileKB',
  'singleMessageSharePct',
  'maxOutputTokens',
  'maxOutputTokensCeiling',
] as const;
export type SettingsPanelKey = (typeof SETTINGS_PANEL_KEYS)[number];

/** VS Code storage key for a panel setting (handles numCtx → mlx.contextTokens remap). */
export function storageKeyForPanelSetting(key: string, provider?: ForgeConfig['provider']): string {
  const cfg = vscode.workspace.getConfiguration('forge');
  const p = provider ?? parseProviderId(cfg.get<string>('provider'));
  if (key === 'numCtx' && p !== 'ollama') return 'mlx.contextTokens';
  return key;
}

/** True when the user set this key at global, workspace, or folder scope (not just the default). */
export function isUserConfiguredPanelSetting(key: string): boolean {
  const storageKey = storageKeyForPanelSetting(key);
  const insp = vscode.workspace.getConfiguration('forge').inspect(storageKey);
  return insp?.globalValue !== undefined || insp?.workspaceValue !== undefined || insp?.workspaceFolderValue !== undefined;
}

/** Keys that appear in the machine recommendations UI and may be skipped by Apply all. */
export const RECOMMENDATION_SETTING_KEYS = [
  'numCtx',
  'mlx.promptCacheGB',
  'mlx.prefillStepSize',
  'mlx.promptCacheSize',
  'mlx.decodeConcurrency',
  'mlx.promptConcurrency',
  'mlx.numDraftTokens',
  'ollama.numBatch',
  'maxOutputTokens',
  'maxOutputTokensCeiling',
  'keepAliveMinutes',
  'maxContextFileKB',
] as const;

export function userConfiguredRecommendationKeys(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of RECOMMENDATION_SETTING_KEYS) {
    out[key] = isUserConfiguredPanelSetting(key === 'numCtx' ? 'numCtx' : key);
  }
  return out;
}

/** Generic setting writer backing the Settings panel — see SETTINGS_PANEL_KEYS. */
export async function setForgeSetting(key: string, value: unknown): Promise<boolean> {
  if (!(SETTINGS_PANEL_KEYS as readonly string[]).includes(key)) return false;
  const cfg = vscode.workspace.getConfiguration('forge');
  const storageKey = storageKeyForPanelSetting(key);
  await cfg.update(storageKey, value, vscode.ConfigurationTarget.Global);
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
