import { McpServerConfig } from './mcpTypes';
import { McpClientLike, McpToolInfo, McpCallResult, splitMcpContentBlocks } from './mcpClient';
import { logger } from '../util/logger';

/**
 * Latest MCP protocolVersion Forge knows how to speak, sent in `initialize`.
 * Kept identical to mcpClient.ts's constant rather than shared/imported —
 * the two transports are independent implementations of the same spec and
 * each should be free to diverge if one side ever needs to (see that file's
 * doc comment for the "why a constant" reasoning, which applies here too).
 */
const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 20_000;
const INIT_TIMEOUT_MS = 10_000;

/**
 * MCP client for a network-reachable server speaking the MCP "Streamable
 * HTTP" transport (the spec's alternative to stdio for servers that aren't
 * a local child process — many self-hosted/custom MCP servers are exposed
 * this way): JSON-RPC 2.0 messages POSTed to a single configured `url`,
 * `Content-Type: application/json`, `Accept: application/json,
 * text/event-stream`, with the response body being EITHER a plain JSON
 * object OR a `text/event-stream` carrying one or more `data:` lines of
 * JSON-RPC messages (the spec allows a server to stream progress/other
 * messages before the final response on the same connection). Built on
 * Node's built-in `fetch` only, same zero-runtime-npm-dependency policy as
 * mcpClient.ts's stdio client and ollama/client.ts.
 *
 * Deliberately mirrors mcpClient.ts's McpClient as closely as the transport
 * difference allows — same timeouts, same "throw on transport failure,
 * return {ok:false} on a tool-level error" contract, same
 * listTools()-returns-[]-rather-than-throws leniency — so mcpManager.ts and
 * everything above it can treat the two transports interchangeably via
 * McpClientLike.
 *
 * One instance per configured server; not reused across "reload MCP
 * servers" (see mcpManager.ts).
 */
export class McpHttpClient implements McpClientLike {
  private readonly url: string;
  private nextId = 1;
  private closed = false;
  /**
   * Session id issued by the server on `initialize` (the `Mcp-Session-Id`
   * response header), per spec echoed back on every subsequent request.
   * Servers that don't use sessions simply never send the header, in which
   * case this stays undefined and every request just omits it.
   */
  private sessionId: string | undefined;

  constructor(private config: McpServerConfig) {
    if (!config.url) throw new Error(`MCP server "${config.name}" is missing "url" (McpHttpClient requires an HTTP server config).`);
    this.url = config.url;
  }

  get name(): string {
    return this.config.name;
  }

  /** Performs the initialize/initialized handshake against the configured URL. Throws with a clear message on any failure — callers (mcpManager.ts) treat one server failing to connect as non-fatal to the others. */
  async connect(): Promise<void> {
    const initResult = await this.request('initialize', {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'forge-vscode', version: '1.0' },
    }, INIT_TIMEOUT_MS);

    const serverVersion = initResult?.protocolVersion;
    if (serverVersion && serverVersion !== CLIENT_PROTOCOL_VERSION) {
      logger.info(`MCP server "${this.config.name}" negotiated protocol version ${serverVersion} (Forge asked for ${CLIENT_PROTOCOL_VERSION}) — continuing, per-spec servers may support an older version.`);
    }

    await this.notify('notifications/initialized', {});
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

  /** Calls one of the server's tools. Never throws for a normal tool-level failure (isError from the server) — that's surfaced as `{ok:false, content}` for the agent to react to, same as any other ToolResult. Only a transport-level failure (unreachable, timeout, malformed response) throws. */
  async callTool(toolName: string, args: Record<string, any>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name: toolName, arguments: args }, REQUEST_TIMEOUT_MS);
    const { text, attachments } = splitMcpContentBlocks(result?.content);
    const content = text || (result?.isError ? 'Tool reported an error with no further detail.' : attachments.length > 0 ? '(no text content — see attachment(s))' : '(no content returned)');
    return { ok: !result?.isError, content, attachments: attachments.length > 0 ? attachments : undefined };
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    // Best-effort session termination per spec (a plain HTTP DELETE, echoing
    // the session id) — fire-and-forget, not awaited: the client is going
    // away either way, and a server that doesn't support it (or is already
    // gone) is not worth surfacing an error for.
    if (this.sessionId) {
      try {
        fetch(this.url, { method: 'DELETE', headers: this.buildHeaders() }).catch(() => { /* best-effort */ });
      } catch {
        /* best-effort */
      }
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers || {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private async request(method: string, params: Record<string, any>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.closed) throw new Error(`MCP server "${this.config.name}" is not connected.`);
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers: this.buildHeaders(), body, signal: controller.signal });
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      throw new Error(timedOut
        ? `MCP server "${this.config.name}" timed out waiting for a response to "${method}".`
        : `Failed to reach MCP server "${this.config.name}" at ${this.url}: ${err?.message || err}`);
    } finally {
      clearTimeout(timer);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`MCP server "${this.config.name}" returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''} for "${method}".`);
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const msg = contentType.includes('text/event-stream') ? await this.readSseResponse(res, id) : await this.readJsonResponse(res, method);

    if (msg.error) throw new Error(msg.error?.message || `MCP server "${this.config.name}" returned an error.`);
    return msg.result;
  }

  private async readJsonResponse(res: Response, method: string): Promise<any> {
    const raw = await res.text();
    if (!raw.trim()) throw new Error(`MCP server "${this.config.name}" returned an empty response for "${method}".`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`MCP server "${this.config.name}" returned a response that isn't valid JSON for "${method}": ${raw.slice(0, 200)}`);
    }
  }

  /**
   * Reads a `text/event-stream` response incrementally, stopping as soon as
   * a `data:` event carrying our request's `id` shows up (per spec a server
   * MAY interleave other messages, e.g. progress notifications, on the same
   * stream before the final response). A compliant server closes the stream
   * right after sending that response anyway, but reading incrementally
   * rather than buffering the whole body means Forge doesn't sit waiting on
   * `Response.text()` for a server that chooses to hold the connection open
   * longer than that.
   */
  private async readSseResponse(res: Response, id: number): Promise<any> {
    const reader: any = (res.body as any)?.getReader?.();
    if (!reader) {
      // No streaming reader available in this runtime's fetch implementation — fall back to buffering the whole body.
      const raw = await res.text();
      return this.extractSseMessage(raw, id);
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const msg = this.parseSseEvent(rawEvent);
          if (msg && msg.id === id) {
            try {
              await reader.cancel();
            } catch {
              /* best-effort */
            }
            return msg;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released via cancel(), or the runtime doesn't need it */
      }
    }

    // Stream ended (server closed it) without an obvious "\n\n" tail — check whatever's left in the buffer before giving up.
    const trailing = this.parseSseEvent(buffer);
    if (trailing && trailing.id === id) return trailing;
    throw new Error(`MCP server "${this.config.name}" closed its event stream without returning a result for this request.`);
  }

  private extractSseMessage(raw: string, id: number): any {
    for (const rawEvent of raw.split('\n\n')) {
      const msg = this.parseSseEvent(rawEvent);
      if (msg && msg.id === id) return msg;
    }
    throw new Error(`MCP server "${this.config.name}" returned an event stream with no message for this request.`);
  }

  /** Extracts and JSON-parses the concatenated `data:` line(s) of one SSE event block. Returns undefined for a block with no data line, or one whose data isn't valid JSON — both are silently skippable per the SSE format (comments, blank keep-alives, etc). */
  private parseSseEvent(rawEvent: string): any {
    const dataLines = rawEvent
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (!dataLines.length) return undefined;
    try {
      return JSON.parse(dataLines.join('\n'));
    } catch {
      return undefined;
    }
  }

  private async notify(method: string, params: Record<string, any>): Promise<void> {
    if (this.closed) return;
    try {
      const res = await fetch(this.url, { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify({ jsonrpc: '2.0', method, params }) });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
    } catch (err) {
      logger.warn(`Failed to send notification to MCP server "${this.config.name}"`, String(err));
    }
  }
}
