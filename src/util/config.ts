import { parseProviderId } from '../llm/provider';
import * as vscode from 'vscode';
import { ForgeMode } from '../agent/modes';
import { McpServerConfig } from '../mcp/mcpTypes';

/** Strongly-typed accessor for the `forge.*` settings, re-read on every call so live edits apply immediately. */
export interface ForgeConfig {
  /** Which runtime chat/agent uses: 'ollama' (default), 'mlx' (mlx_lm.server), or 'openai-compatible'. See llm/factory.ts. */
  provider: 'ollama' | 'mlx' | 'openai-compatible';
  mlxBaseUrl: string;
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

  /**
   * Opt-in structured-output tool calling (see agent/structuredOutput.ts):
   * off by default because this sandbox has no live Ollama server to verify
   * how well constrained decoding actually behaves with Forge's target local
   * models — try it, and turn it back off if it doesn't help your model.
   */
  structuredOutputEnabled: boolean;
  /** Optional internal no-tool "think first" pass at the start of a turn in Agent/Auto/Outcome mode — see agent/planFirst.ts. Off by default: it's an extra full model call on every turn, real latency cost for a real (but not universally needed) accuracy gain. */
  planFirstEnabled: boolean;
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
}

export function getConfig(): ForgeConfig {
  const cfg = vscode.workspace.getConfiguration('forge');
  return {
    provider: parseProviderId(cfg.get<string>('provider')),
    mlxBaseUrl: (cfg.get<string>('mlx.baseUrl') || 'http://127.0.0.1:8123').replace(/\/+$/, ''),
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
    contextChunkCount: cfg.get<number>('contextChunkCount') ?? 8,
    maxContextFileKB: cfg.get<number>('maxContextFileKB') ?? 200,
    // 0 = let Ollama use its own (small, often silently-truncating) default.
    // Set this to your model's real max (check `ollama show <model>`) to stop
    // long agent sessions from quietly losing early context.
    // Ollama takes the window per request (forge.numCtx); MLX / OpenAI-compatible servers fix it at start-up, so for those it is the
    // separately-configured forge.mlx.contextTokens (used for compaction thresholds and the context meter).
    numCtx: parseProviderId(cfg.get<string>('provider')) === 'ollama' ? cfg.get<number>('numCtx') ?? 32768 : cfg.get<number>('mlx.contextTokens') ?? 32768,
    // -1 = never unload the model between messages (avoids paying a full
    // reload + KV-cache-rebuild cost every time you pause to think).
    // 0 = server default (~5 min idle unload).
    keepAliveMinutes: cfg.get<number>('keepAliveMinutes') ?? -1,
    modelRouting: cfg.get<Partial<Record<ForgeMode, string>>>('modelRouting') || {},
    subAgentModel: cfg.get<string>('subAgentModel') || '',
    subAgentMaxIterations: cfg.get<number>('subAgentMaxIterations') ?? 40,
    maxSubAgentDepth: cfg.get<number>('maxSubAgentDepth') ?? 2,
    showStatusMessages: cfg.get<boolean>('showStatusMessages') ?? true,
    loopDetectionEnabled: cfg.get<boolean>('loopDetection.enabled') ?? true,
    traceEnabled: cfg.get<boolean>('trace.enabled') ?? true,
    structuredOutputEnabled: cfg.get<boolean>('structuredOutput.enabled') ?? false,
    planFirstEnabled: cfg.get<boolean>('planFirst.enabled') ?? false,
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
    webSearchMaxFetchChars: cfg.get<number>('webSearch.maxFetchChars') ?? 500_000,
    webSearchSearxngUrl: cfg.get<string>('webSearch.searxngUrl') || '',
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
  'loopDetection.enabled',
  'structuredOutput.enabled',
  'planFirst.enabled',
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
