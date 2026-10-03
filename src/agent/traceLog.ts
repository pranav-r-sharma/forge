import * as fs from 'fs';
import * as path from 'path';
import { sha1 } from '../util/hash';
import type { HwSnapshot } from '../util/hwSampler';

/**
 * Per-iteration trace of the agent loop (v0.15.0 plan §1.1): one JSON line per model call / tool call, written to
 * `.forge/traces/<sessionId>.jsonl`. This is what makes performance work measurable instead of guessed — prompt tokens
 * actually evaluated vs. sent, repeated reads, tool time, model time, where the seconds go.
 *
 * Design rules: tracing must NEVER break or slow a turn (every failure is swallowed; writes are queued and off the hot path);
 * it stores no file contents or command output (only sizes and a short hash of the arguments), so it is safe to keep next to a repo.
 */
export interface TraceRecord {
  v: 1;
  ts: string;
  sessionId: string;
  turnId: string;
  iter: number;
  /** 0 = the main agent, 1+ = nested sub-agents. */
  depth: number;
  model: string;
  mode: string;
  // ---- the prompt as sent to the model ----
  promptChars: number;
  promptMsgs: number;
  /** Old read_file results replaced by "superseded" stubs in this prompt (context pruning) — each is a future re-read risk. */
  staleReadStubs: number;
  /** True when the prompt contains an LLM compaction summary. */
  compacted: boolean;
  /** Set only on steps where the append-only prompt was deliberately rewritten (each such step costs one cache miss): 'mask' = stale reads stubbed, 'compact' = oldest turns summarized. */
  viewEvent?: 'mask' | 'compact';
  /** Estimated prompt size in tokens used for the water-mark decision. */
  estPromptTokens?: number;
  // ---- the model call ----
  modelMs: number;
  /** Prompt tokens the runtime reports it actually EVALUATED (a cache hit makes this smaller than what was sent). */
  promptTokens?: number;
  /** Full prompt size in tokens when the runtime reports it (evaluated + cached). */
  promptTotalTokens?: number;
  /** Prompt tokens the runtime served from its prompt cache (MLX server: usage.prompt_tokens_details.cached_tokens). With promptTokens gives the TRUE cache-hit rate. */
  cachedTokens?: number;
  /** Estimated tokens in the sent prompt (from chars/token); used with promptTokens on Ollama when cached_tokens is not reported. */
  promptSentTokens?: number;
  evalTokens?: number;
  tokPerSec?: number;
  promptEvalMs?: number;
  /** Prefill throughput from evaluated prompt tokens and promptEvalMs (runtime-reported or TTFT-approximated). */
  prefillTokPerSec?: number;
  loadMs?: number;
  /** 'length' = the reply was cut off by the output limit (incomplete). */
  finishReason?: string;
  /** The thinking flag sent for this call (undefined = the model's default). With forge.thinking='auto' it turns true when the agent gets stuck. */
  thinking?: boolean;
  // ---- the action taken ----
  tool?: string;
  argsHash?: string;
  path?: string;
  range?: string;
  ok?: boolean;
  toolMs?: number;
  resultChars?: number;
  /** read_file whose lines were all already shown this turn (and not invalidated by a write/command since). */
  redundantRead?: boolean;
  /** Hardware state when this iteration was recorded (latest sampler reading) — so every benchmark carries the conditions it ran under. Absent when no sampler is wired or nothing could be read. */
  hw?: TraceHw;
  final?: boolean;
  note?: string;
}

export interface TraceHw {
  usedGB?: number;
  availableGB?: number;
  swapGB?: number;
  pressure?: string;
  gpuAvgPct?: number;
  gpuPeakPct?: number;
  gpuMemGB?: number;
}

/** Compact, plain-number view of a sampler snapshot for the trace. Returns undefined (key omitted) when there is nothing trustworthy to record. */
export function hwForTrace(snap: HwSnapshot | undefined): TraceHw | undefined {
  if (!snap) return undefined;
  const m = snap.memory;
  const g = snap.gpus[0];
  if (!m && !g) return undefined;
  return {
    usedGB: m?.usedGB, availableGB: m?.availableGB, swapGB: m?.swapUsedGB, pressure: m?.pressure,
    gpuAvgPct: g?.avgPct, gpuPeakPct: g?.peakPct, gpuMemGB: g?.inUseGB,
  };
}

/** Fields the loop supplies; the writer stamps v / ts / sessionId. */
export type TraceInput = Omit<TraceRecord, 'v' | 'ts' | 'sessionId'>;

/** Short, stable hash of tool arguments (key order does not matter). Never stores the arguments themselves. */
export function argsHash(args: unknown): string {
  return sha1(stableStringify(args)).slice(0, 10);
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** Pulls the file path and line range out of a tool call's args for the trace (paths and numbers only — no content). */
/** Derives trace-ready prompt-cache metrics from runtime metrics + an optional sent-token estimate. */
export function promptCacheMetricsForTrace(
  m: { promptTokens?: number; cachedTokens?: number; promptTotalTokens?: number; promptEvalDurationMs?: number } | undefined,
  estPromptTokens?: number
): Pick<TraceRecord, 'promptTokens' | 'promptTotalTokens' | 'cachedTokens' | 'promptSentTokens' | 'prefillTokPerSec'> {
  if (!m) return {};
  const evaluated = m.promptTokens;
  const cached = m.cachedTokens;
  const total = m.promptTotalTokens ?? (evaluated !== undefined && cached !== undefined ? evaluated + cached : undefined);
  const sent = estPromptTokens;
  const cachedOut =
    cached ??
    (sent !== undefined && evaluated !== undefined && sent > evaluated ? sent - evaluated : undefined);
  const prefillMs = m.promptEvalDurationMs;
  const prefillTokPerSec =
    evaluated !== undefined && prefillMs !== undefined && prefillMs > 0
      ? Math.round((evaluated / (prefillMs / 1000)) * 10) / 10
      : undefined;
  return {
    promptTokens: evaluated,
    promptTotalTokens: total,
    cachedTokens: cachedOut,
    promptSentTokens: sent,
    prefillTokPerSec,
  };
}

export function describeArgsForTrace(tool: string, args: Record<string, any> | undefined): { path?: string; range?: string } {
  const a = args || {};
  const p = typeof a.path === 'string' ? a.path : typeof a.file === 'string' ? a.file : undefined;
  let range: string | undefined;
  if (tool === 'read_file' && (a.start_line || a.end_line)) range = `${a.start_line ?? 1}-${a.end_line ?? 'end'}`;
  return { path: p, range };
}

export function tracePathFor(workspaceRootFsPath: string, sessionId: string): string {
  return path.join(workspaceRootFsPath, '.forge', 'traces', `${sessionId.replace(/[^\w.-]/g, '_')}.jsonl`);
}

/** Appends trace lines in order, off the caller's path. Rotates to `<file>.1` past `maxBytes`. Never throws. */
export class TraceWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly sessionId: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  write(input: TraceInput): void {
    const rec: TraceRecord = { v: 1, ts: new Date().toISOString(), sessionId: this.sessionId, ...input };
    const line = JSON.stringify(rec) + '\n';
    this.chain = this.chain.then(() => this.append(line)).catch(() => undefined);
  }

  /** Resolves when everything written so far has been flushed (used by tests and on shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      try {
        const st = await fs.promises.stat(this.file);
        if (st.size + line.length > this.maxBytes) await fs.promises.rename(this.file, this.file + '.1');
      } catch {
        /* no file yet */
      }
      await fs.promises.appendFile(this.file, line, 'utf8');
    } catch {
      /* tracing is best-effort by design */
    }
  }
}

// ---- turn lifecycle events (separate file so the per-iteration trace and its report tooling are unchanged) ----

/** `.forge/traces/<sessionId>.turns.jsonl`: why every turn ended, and which model calls started but never returned. */
export function turnEventsPathFor(workspaceRootFsPath: string, sessionId: string): string {
  return path.join(workspaceRootFsPath, '.forge', 'traces', `${sessionId.replace(/[^\w.-]/g, '_')}.turns.jsonl`);
}

export type TurnEndReason =
  | 'final' // a normal answer
  | 'iteration-cap' // "Stopped after N steps"
  | 'context-full'
  | 'incomplete-cap' // gave up after repeated truncated/abandoned/foreign tool calls
  | 'loop-detected' // the loop detector stopped the turn ("Forge stopped: possible loop detected")
  | 'aborted' // user pressed Stop (or the call was cancelled)
  | 'error' // provider/connection error shown to the user
  | 'exception' // runAgentTurn threw
  | 'no-terminal-event'; // the loop returned without emitting final/aborted/error — a silent stop

export interface TurnEndFacts {
  /** The last terminal event emitted by the turn, if any. */
  terminal?: { type: 'final'; text: string } | { type: 'aborted' } | { type: 'error'; message: string };
  threw?: boolean;
}

/** Pure: names why a turn ended from the events it emitted. Exported for tests. */
export function classifyTurnEnd(f: TurnEndFacts): TurnEndReason {
  if (f.threw) return 'exception';
  const t = f.terminal;
  if (!t) return 'no-terminal-event';
  if (t.type === 'aborted') return 'aborted';
  if (t.type === 'error') return 'error';
  if (/^Stopped after \d+ steps/.test(t.text)) return 'iteration-cap';
  if (/^Context is full/.test(t.text)) return 'context-full';
  if (/^Forge stopped: possible loop detected/.test(t.text)) return 'loop-detected';
  if (/\[System\] stopped: could not (produce a valid action|resend)/.test(t.text)) return 'incomplete-cap';
  return 'final';
}

/** Free-form lifecycle events as JSON lines. Same rules as TraceWriter: queued, off the hot path, never throws, rotates at 5 MB. */
export class TurnEventWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly sessionId: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  write(event: Record<string, unknown>): void {
    const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), sessionId: this.sessionId, ...event }) + '\n';
    this.chain = this.chain.then(() => this.append(line)).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      try {
        const st = await fs.promises.stat(this.file);
        if (st.size + line.length > this.maxBytes) await fs.promises.rename(this.file, this.file + '.1');
      } catch {
        /* no file yet */
      }
      await fs.promises.appendFile(this.file, line, 'utf8');
    } catch {
      /* best-effort by design */
    }
  }
}
