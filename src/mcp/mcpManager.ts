import { McpClient } from './mcpClient';
import { DynamicToolSpec, McpServerConfig } from './mcpTypes';
import { ToolExecContext, ToolResult } from '../agent/types';
import { logger } from '../util/logger';

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `mcp_${Date.now().toString(36)}_${callCounter}`;
}

/** Keeps an MCP tool name safe to appear as a JSON string in the model's tool-call contract and as a lookup key — collapses anything that isn't alphanumeric/underscore to a single underscore. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

/**
 * Owns every configured MCP server ("I have had Claude build me some very
 * nice MCPs, and I want them to natively connect to this Agent"): spawns
 * each one (best-effort — one server failing to start never prevents the
 * others, or the extension, from working), lists its tools, and exposes them
 * as `DynamicToolSpec`s the agent loop can call exactly like a built-in tool.
 *
 * Design choices worth calling out:
 * - **Zero new npm dependencies** (see mcpClient.ts) — a hand-written stdio
 *   JSON-RPC client instead of `@modelcontextprotocol/sdk`, consistent with
 *   every other Forge subsystem.
 * - **Namespaced tool names** (`mcp_<server>_<tool>`, sanitized) so two
 *   different MCP servers can't collide with each other or with a built-in
 *   tool name.
 * - **Approval-gated like `run_command`**, not auto-trusted: an MCP tool is
 *   arbitrary third-party code with side effects Forge has no way to
 *   inspect ahead of time, so each call goes through the same
 *   `ApprovalBroker` channel run_command uses (reusing its "command"
 *   approval kind rather than inventing a new UI affordance — see
 *   agentLoop.ts's wiring). That broker already auto-approves in
 *   Auto/Outcome mode and per `forge.autoApproveCommands`/
 *   `requireApprovalForCommands`, so the existing approval settings apply
 *   here too rather than needing a parallel set just for MCP.
 * - **Config lives in plain settings** (`forge.mcp.servers`), NOT
 *   `vscode.SecretStorage` — unlike web-search API keys (see
 *   websearch/keyStore.ts), an MCP server's config is a whole
 *   command+args+env shape, not a single secret string, and VS Code's
 *   SecretStorage has no natural place for that. If a server needs an API
 *   token, it goes in that server's own `env` entry, which — like the rest
 *   of `forge.mcp.servers` — lives in plain `settings.json`. This is an
 *   honestly-documented limitation (see README's Known limitations), not
 *   something this round pretends to solve.
 */
export class McpManager {
  private clients: McpClient[] = [];
  private toolSpecs: DynamicToolSpec[] = [];
  private startErrors: string[] = [];
  private starting: Promise<void> | undefined;

  constructor(private getServers: () => McpServerConfig[]) {}

  /** Every currently-usable tool across every connected server — safe to call before start() resolves (returns whatever's ready so far / empty). */
  listToolSpecs(): DynamicToolSpec[] {
    return this.toolSpecs;
  }

  /** Human-readable status for a settings/diagnostics view: which servers connected, how many tools each exposed, and any startup errors. */
  status(): { server: string; connected: boolean; toolCount: number }[] {
    const configured = this.getServers();
    return configured.map((cfg) => {
      const client = this.clients.find((c) => c.name === cfg.name);
      const toolCount = this.toolSpecs.filter((t) => t.name.startsWith(`mcp_${sanitize(cfg.name)}_`)).length;
      return { server: cfg.name, connected: !!client, toolCount };
    });
  }

  lastStartErrors(): string[] {
    return this.startErrors;
  }

  /** Spawns every configured server and lists its tools. Safe to call multiple times — concurrent calls share one in-flight start. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Disposes every current client and starts fresh from the latest config — "Forge: Reload MCP Servers", for after editing forge.mcp.servers or restarting a crashed server. */
  async reload(): Promise<void> {
    this.disposeAll();
    await this.start();
  }

  disposeAll() {
    for (const client of this.clients) client.dispose();
    this.clients = [];
    this.toolSpecs = [];
  }

  private async doStart(): Promise<void> {
    this.disposeAll();
    this.startErrors = [];
    const configs = this.getServers();
    for (const cfg of configs) {
      if (!cfg?.name || !cfg?.command) {
        this.startErrors.push(`Skipped an MCP server entry missing "name" or "command".`);
        continue;
      }
      const client = new McpClient(cfg);
      try {
        await client.connect();
      } catch (err: any) {
        const msg = err?.message || String(err);
        logger.warn('MCP server failed to start', cfg.name, msg);
        this.startErrors.push(msg);
        continue;
      }
      this.clients.push(client);
      const tools = await client.listTools();
      for (const tool of tools) {
        const toolName = `mcp_${sanitize(cfg.name)}_${sanitize(tool.name)}`;
        this.toolSpecs.push(buildToolSpec(toolName, cfg.name, tool.name, tool.description, client));
      }
      logger.info(`MCP server "${cfg.name}" connected with ${tools.length} tool(s).`);
    }
  }
}

function buildToolSpec(toolName: string, serverName: string, remoteName: string, description: string | undefined, client: McpClient): DynamicToolSpec {
  return {
    name: toolName,
    describe: `[MCP: ${serverName}] ${description || `Calls the "${remoteName}" tool on the connected "${serverName}" MCP server.`}`,
    exampleArgs: {},
    run: async (args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> => {
      const callId = nextCallId();
      const label = `MCP tool ${serverName}/${remoteName}(${summarizeArgs(args)})`;
      const approved = await ctx.requestCommandApproval(label, callId);
      if (!approved) {
        return { ok: false, content: 'The user did not approve this MCP tool call. Ask before proceeding, or try a different approach.' };
      }
      try {
        const result = await client.callTool(remoteName, args || {});
        return { ok: result.ok, content: result.text };
      } catch (err: any) {
        return { ok: false, content: `MCP tool "${serverName}/${remoteName}" failed: ${err?.message || err}` };
      }
    },
  };
}

function summarizeArgs(args: Record<string, any>): string {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 150 ? json.slice(0, 150) + '…' : json;
  } catch {
    return '(unserializable args)';
  }
}
