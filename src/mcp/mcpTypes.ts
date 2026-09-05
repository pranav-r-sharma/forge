import { ToolExecContext, ToolResult } from '../agent/types';

/**
 * One entry in `forge.mcp.servers` — either a local MCP server Forge spawns
 * and talks to over stdio, or a network-reachable one Forge talks to over
 * the MCP "Streamable HTTP" transport (see mcpHttpClient.ts). This is one
 * flat interface with both sets of fields optional, rather than a strict
 * discriminated union, because the actual data always arrives as untyped
 * JSON out of VS Code's settings.json — mcpManager.ts's doStart() validates
 * at runtime that EXACTLY ONE of `command`/`url` is set and rejects (with a
 * clear per-server error, non-fatal to the other configured servers)
 * anything else, which is where this really gets enforced.
 */
export interface McpServerConfig {
  /** Short identifier used to namespace this server's tools (e.g. "github" -> tool names like "mcp__github__search_issues" — see mcpManager.ts's doc comment on the 0.14.0 double-underscore convention) and to label them in the UI/approval prompts. */
  name: string;

  // ---------- stdio transport — set `command`, leave `url` unset ----------
  /** Executable to spawn (e.g. "npx", "node", "python", or an absolute path). */
  command?: string;
  args?: string[];
  cwd?: string;
  /** Extra environment variables for the spawned process, merged over the extension host's own `process.env`. Put secrets (API tokens, etc.) here rather than in `args` where they'd be visible in a process list — but note this still lives in VS Code's plain settings.json, not SecretStorage (see mcpManager.ts's doc comment for why, and README's Known limitations). */
  env?: Record<string, string>;

  // ---------- HTTP ("Streamable HTTP") transport — set `url`, leave `command` unset ----------
  /** Endpoint of an MCP server speaking the MCP Streamable HTTP transport — JSON-RPC 2.0 POSTed here, responding with either `application/json` or `text/event-stream` (see mcpHttpClient.ts). */
  url?: string;
  /** Extra HTTP headers sent with every request to `url` — e.g. `{"Authorization": "Bearer ..."}`. Same plain-settings.json caveat as `env` above applies to anything secret placed here. */
  headers?: Record<string, string>;
}

/**
 * A tool contributed by a connected MCP server, normalized to the same shape
 * agentLoop.ts already knows how to call a tool through. Kept distinct from
 * `agent/types.ts`'s `ToolSpec` (whose `name` is the closed `ToolName`
 * union) rather than widening that type — an MCP server's tool names are
 * arbitrary, server-defined strings, and keeping that out of `ToolName` means
 * every existing exhaustiveness check over Forge's own built-in tools stays
 * meaningful.
 */
export interface DynamicToolSpec {
  /** Namespaced, e.g. "mcp__<server>__<tool>" — see mcpManager.ts's sanitize()/buildToolSpec(). Double-underscore separator matches the convention Claude Code itself uses for its own MCP-sourced tools, chosen specifically so a server or tool name that happens to contain a single underscore can't be misread as part of the separator. */
  name: string;
  /** The configured server name this tool came from, stored directly rather than re-derived from `name` by string-prefix matching (status()/dispatch used to do that, which broke down the moment `sanitize()` could map two different inputs to the same namespaced prefix). */
  serverName: string;
  /** The tool's own name as the server itself calls it (pre-sanitization, pre-namespacing) — what's actually sent in `tools/call`'s `name` field. */
  remoteName: string;
  describe: string;
  exampleArgs: Record<string, any>;
  /** The server's own JSON Schema for this tool's input, verbatim from `tools/list` — MCP standardization (0.14.0): kept alongside the synthesized `exampleArgs`/describe-string rendering (see mcpManager.ts's buildToolSpec()) rather than only flattened into prose, so anything that wants the real schema (structured-output validation, a future stricter dispatcher) has it. Undefined for a server that didn't advertise one. */
  inputSchema?: Record<string, any>;
  run: (args: Record<string, any>, ctx: ToolExecContext) => Promise<ToolResult>;
}
