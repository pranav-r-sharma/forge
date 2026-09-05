import { spawn } from 'child_process';
import { McpServerConfig } from './mcpTypes';
import { logger } from '../util/logger';

// Not imported as a named type, same reason as commandTool.ts's
// `SpawnedProcess`/backgroundProcessManager.ts's — the sandboxed dev build's
// type shim doesn't export ChildProcess from its minimal child_process
// stand-in. `ReturnType<typeof spawn>` resolves correctly either way.
type SpawnedProcess = ReturnType<typeof spawn>;

/**
 * Latest MCP protocolVersion Forge knows how to speak, sent in `initialize`.
 * Per the spec, a server may reply with a different (older) version it
 * supports instead — see connect()'s handling of that. Keeping this a single
 * named constant makes it obvious what to bump when the spec moves again.
 */
const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 10_000;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpCallResult {
  ok: boolean;
  text: string;
}

/**
 * The subset of McpClient/McpHttpClient's surface mcpManager.ts actually
 * needs — lets doStart() treat a stdio-spawned server and an HTTP-connected
 * one identically once construction has picked the right concrete class.
 */
export interface McpClientLike {
  readonly name: string;
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(toolName: string, args: Record<string, any>): Promise<McpCallResult>;
  dispose(): void;
}

/**
 * A minimal, hand-written MCP client speaking JSON-RPC 2.0 over a spawned
 * process's stdio — no `@modelcontextprotocol/sdk` dependency, consistent
 * with Forge's zero-runtime-npm-dependency policy (see README/CHANGELOG;
 * this is the same reasoning that kept the Ollama client on bare `fetch`).
 * The wire format (newline-delimited JSON-RPC messages over stdin/stdout) is
 * simple enough that a from-scratch client is a few dozen lines, not a
 * dependency. For a network-reachable server instead of a local child
 * process, see mcpHttpClient.ts's McpHttpClient, which speaks the MCP
 * "Streamable HTTP" transport but otherwise mirrors this class's behavior
 * (timeouts, error surfacing, disposal) closely enough that mcpManager.ts
 * treats the two interchangeably via McpClientLike.
 *
 * One instance per configured server (see mcpManager.ts, which owns the
 * lifecycle of all of them). Not reused across "reload MCP servers" — a
 * reload disposes every client and constructs fresh ones.
 */
export class McpClient implements McpClientLike {
  private child: SpawnedProcess | undefined;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (err: Error) => void }>();
  private closed = false;
  private closeReason: string | undefined;

  constructor(private config: McpServerConfig) {
    if (!config.command) throw new Error(`MCP server "${config.name}" is missing "command" (McpClient requires a stdio server config).`);
  }

  get name(): string {
    return this.config.name;
  }

  /** Spawns the server process and performs the initialize/initialized handshake. Throws with a clear message on any failure — callers (mcpManager.ts) treat one server failing to start as non-fatal to the others. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: SpawnedProcess;
      try {
        // Cast to `any`: the sandbox's dev-only type shim
        // (_devtools/shim.d.ts) only declares a simplified 2-argument
        // `spawn(command, options)` overload, not real @types/node's
        // 3-argument `spawn(command, args, options)` — same class of
        // shim-vs-real-types gap as commandTool.ts's SpawnedProcess/
        // NodeJS.Signals workarounds. This still compiles and behaves
        // correctly against the real @types/node used by the actual build.
        child = (spawn as any)(this.config.command, this.config.args || [], {
          cwd: this.config.cwd,
          env: { ...process.env, ...(this.config.env || {}) },
        });
      } catch (err: any) {
        reject(new Error(`Failed to start MCP server "${this.config.name}": ${err?.message || err}`));
        return;
      }
      this.child = child;

      let settled = false;
      const onSpawnError = (err: any) => {
        if (settled) return;
        settled = true;
        reject(new Error(`MCP server "${this.config.name}" failed to start: ${err?.message || err}`));
      };
      child.once('error', onSpawnError);

      child.stdout?.on('data', (buf: Buffer) => this.onData(buf));
      child.stderr?.on('data', (buf: Buffer) => {
        // A server's stderr is diagnostic noise, not protocol traffic — log
        // it (capped) rather than surfacing it as a tool error, since many
        // MCP servers log their own startup banners there.
        logger.warn(`[mcp:${this.config.name}] ${buf.toString('utf8').slice(0, 500)}`);
      });
      child.on('close', (code: number | null) => {
        this.closed = true;
        this.closeReason = `MCP server "${this.config.name}" exited (code ${code ?? 'unknown'}).`;
        this.rejectAllPending(new Error(this.closeReason));
      });

      // Give the process a tick to fail fast (bad command, missing binary)
      // before we start the real JSON-RPC handshake against it.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.removeListener('error', onSpawnError);
        resolve();
      }, 50);
    });

    if (this.closed) throw new Error(this.closeReason || `MCP server "${this.config.name}" exited before it could be used.`);

    const initResult = await this.request('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'forge-vscode', version: '1.0' },
    }, INIT_TIMEOUT_MS);

    const serverVersion = initResult?.protocolVersion;
    if (serverVersion && serverVersion !== CLIENT_PROTOCOL_VERSION) {
      logger.info(`MCP server "${this.config.name}" negotiated protocol version ${serverVersion} (Forge asked for ${CLIENT_PROTOCOL_VERSION}) — continuing, per-spec servers may support an older version.`);
    }

    this.notify('notifications/initialized', {});
  }

  /** Lists the tools this server currently exposes. Returns [] (not a thrown error) if the server doesn't support tools/list or returns something unusable — a server with zero tools is a valid, if useless, state. */
  async listTools(): Promise<McpToolInfo[]> {
    try {
      const result = await this.request('tools/list', {});
      const tools = result?.tools;
      if (!Array.isArray(tools)) return [];
      return tools
        .filter((t: any) => t && typeof t.name === 'string')
        .map((t: any) => ({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined, inputSchema: t.inputSchema }));
    } catch (err) {
      logger.warn(`MCP server "${this.config.name}" tools/list failed`, String(err));
      return [];
    }
  }

  /** Calls one of the server's tools. Never throws for a normal tool-level failure (isError from the server) — that's surfaced as `{ok:false, text}` for the agent to react to, same as any other ToolResult. Only a transport-level failure (process gone, timeout) throws. */
  async callTool(toolName: string, args: Record<string, any>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name: toolName, arguments: args }, REQUEST_TIMEOUT_MS);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((block: any) => (block && typeof block.text === 'string' ? block.text : block && block.type ? `[${block.type} content]` : ''))
      .filter(Boolean)
      .join('\n')
      || (result?.isError ? 'Tool reported an error with no further detail.' : '(no content returned)');
    return { ok: !result?.isError, text };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.rejectAllPending(new Error(`MCP server "${this.config.name}" was disposed.`));
    try {
      this.child?.kill();
    } catch {
      /* best-effort */
    }
  }

  private onData(buf: Buffer) {
    this.buffer += buf.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server writing non-protocol text to stdout — ignore rather than crash the client
      }
      if (msg && typeof msg === 'object' && 'id' in msg && msg.id !== null && msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error?.message || 'MCP server returned an error.'));
          else waiter.resolve(msg.result);
        }
      }
      // Notifications from the server (no id) are intentionally ignored —
      // Forge doesn't currently act on server-initiated notifications
      // (progress, logging, resource-change events).
    }
  }

  private request(method: string, params: Record<string, any>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.closed) return Promise.reject(new Error(this.closeReason || `MCP server "${this.config.name}" is not connected.`));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.config.name}" timed out waiting for a response to "${method}".`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.child?.stdin?.write(payload);
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to write to MCP server "${this.config.name}": ${err?.message || err}`));
      }
    });
  }

  private notify(method: string, params: Record<string, any>) {
    if (this.closed) return;
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (err) {
      logger.warn(`Failed to send notification to MCP server "${this.config.name}"`, String(err));
    }
  }

  private rejectAllPending(err: Error) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}
