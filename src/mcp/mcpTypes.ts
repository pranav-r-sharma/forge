import { ToolExecContext, ToolResult } from '../agent/types';

/** One entry in `forge.mcp.servers` — a local MCP server Forge spawns and talks to over stdio. */
export interface McpServerConfig {
  /** Short identifier used to namespace this server's tools (e.g. "github" -> tool names like "mcp_github_search_issues") and to label them in the UI/approval prompts. */
  name: string;
  /** Executable to spawn (e.g. "npx", "node", "python", or an absolute path). */
  command: string;
  args?: string[];
  cwd?: string;
  /** Extra environment variables for the spawned process, merged over the extension host's own `process.env`. Put secrets (API tokens, etc.) here rather than in `args` where they'd be visible in a process list — but note this still lives in VS Code's plain settings.json, not SecretStorage (see mcpManager.ts's doc comment for why, and README's Known limitations). */
  env?: Record<string, string>;
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
  /** Namespaced, e.g. "mcp_<server>_<tool>" — see mcpManager.ts's sanitizeToolName(). */
  name: string;
  describe: string;
  exampleArgs: Record<string, any>;
  run: (args: Record<string, any>, ctx: ToolExecContext) => Promise<ToolResult>;
}
