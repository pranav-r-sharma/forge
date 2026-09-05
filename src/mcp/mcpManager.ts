import { McpClient, McpClientLike } from './mcpClient';
import { McpHttpClient } from './mcpHttpClient';
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
 * MCP standardization (0.14.0): a tool's exposed name, `mcp__<server>__<tool>`
 * — double-underscore, matching the convention Claude Code itself uses for
 * its own MCP-sourced tools (see mcpTypes.ts's DynamicToolSpec doc comment
 * for why double- rather than single-underscore). Changed from 0.11-0.13's
 * `mcp_<server>_<tool>` single-underscore form; this only affects freshly
 * dispatched tool calls going forward — a persisted chat transcript that
 * already contains the old single-underscore name in its history is just
 * historical text, never re-parsed or re-dispatched, so no migration is
 * needed for existing sessions.
 */
export function namespacedToolName(serverName: string, remoteName: string): string {
  return `mcp__${sanitize(serverName)}__${sanitize(remoteName)}`;
}

/**
 * MCP standardization (0.14.0): synthesizes a plausible non-empty example
 * `args` object from a tool's own JSON Schema `inputSchema`, for the system
 * prompt's `example: {...}` line (see systemPrompt.ts) — before this, every
 * MCP tool showed the model a bare `exampleArgs: {}` regardless of what
 * parameters it actually took, because the schema was fetched via
 * `tools/list` and then never used for anything. Shows every REQUIRED
 * property (so the model always sees what it must supply); if a schema
 * declares no required properties at all, shows up to the first 3 properties
 * instead, so a tool that does take optional args still demonstrates its
 * shape rather than looking argument-less. Deliberately not a full
 * JSON-Schema-to-example generator (no $ref resolution, no oneOf/anyOf
 * branching, no nested-object property walking) — good enough to stop the
 * model guessing blind for the common flat-object-schema case real MCP
 * servers actually use.
 */
export function exampleArgsFromSchema(schema: Record<string, any> | undefined): Record<string, any> {
  if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return {};
  const required: string[] = Array.isArray(schema.required) ? schema.required.filter((r: any) => typeof r === 'string') : [];
  const propNames = Object.keys(schema.properties);
  const names = required.length > 0 ? required : propNames.slice(0, 3);
  const out: Record<string, any> = {};
  for (const name of names) {
    if (schema.properties[name] !== undefined) out[name] = placeholderForSchemaProp(schema.properties[name]);
  }
  return out;
}

function placeholderForSchemaProp(propSchema: any): any {
  if (!propSchema || typeof propSchema !== 'object') return '...';
  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) return propSchema.enum[0];
  if (propSchema.default !== undefined) return propSchema.default;
  const type = Array.isArray(propSchema.type) ? propSchema.type[0] : propSchema.type;
  switch (type) {
    case 'string':
      return typeof propSchema.description === 'string' && propSchema.description.length > 0
        ? `<${propSchema.description.replace(/\s+/g, ' ').trim().slice(0, 40)}>`
        : '...';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '...';
  }
}

/**
 * MCP standardization (0.14.0): a compact, single-line rendering of a tool's
 * parameter names/types/required-ness, appended to its `describe` string —
 * `exampleArgs` above shows ONE valid call; this shows the tool's actual
 * shape (including optional parameters an example wouldn't demonstrate) so
 * the model has both. Returns '' for a schema with no properties to
 * describe (nothing to add), not a placeholder — callers append unconditionally.
 */
export function summarizeSchemaForDescribe(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return '';
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
  const parts = Object.entries(schema.properties as Record<string, any>).map(([name, propSchema]) => {
    const type = Array.isArray(propSchema?.type) ? propSchema.type.join('|') : propSchema?.type || 'any';
    return `${name}${required.has(name) ? '' : '?'}: ${type}`;
  });
  return parts.length > 0 ? ` Parameters: {${parts.join(', ')}}.` : '';
}

/**
 * Owns every configured MCP server ("I have had Claude build me some very
 * nice MCPs, and I want them to natively connect to this Agent"): connects
 * to each one (best-effort — one server failing to start never prevents the
 * others, or the extension, from working), lists its tools, and exposes them
 * as `DynamicToolSpec`s the agent loop can call exactly like a built-in tool.
 * A server is either spawned locally over stdio (`McpClient`) or reached
 * over the network via the MCP "Streamable HTTP" transport (`McpHttpClient`)
 * — see doStart()'s command/url validation — but downstream of construction
 * every server is just an `McpClientLike`, so tool discovery, namespacing,
 * approval-gating and dispatch below don't care which transport it is.
 *
 * Design choices worth calling out:
 * - **Zero new npm dependencies** (see mcpClient.ts/mcpHttpClient.ts) —
 *   hand-written stdio and HTTP JSON-RPC clients instead of
 *   `@modelcontextprotocol/sdk`, consistent with every other Forge subsystem.
 * - **Namespaced tool names** (`mcp__<server>__<tool>`, sanitized, double-
 *   underscore separator — see namespacedToolName()'s doc comment) so two
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
  private clients: McpClientLike[] = [];
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
      // Matched on the stored `serverName` field (set once per tool at
      // discovery time), not re-derived by re-sanitizing cfg.name and
      // string-prefix-matching against the namespaced tool name — two
      // different configured server names could in principle sanitize to
      // the same prefix, which the old prefix-matching approach couldn't
      // tell apart.
      const toolCount = this.toolSpecs.filter((t) => t.serverName === cfg.name).length;
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
      if (!cfg?.name) {
        this.startErrors.push(`Skipped an MCP server entry missing "name".`);
        continue;
      }
      const hasCommand = typeof cfg.command === 'string' && cfg.command.length > 0;
      const hasUrl = typeof cfg.url === 'string' && cfg.url.length > 0;
      if (hasCommand === hasUrl) {
        // Neither set, or both set — either way it's ambiguous which transport was meant, so skip rather than guess.
        this.startErrors.push(`Skipped MCP server "${cfg.name}" — configure exactly one of "command" (stdio) or "url" (HTTP), not ${hasCommand ? 'both' : 'neither'}.`);
        continue;
      }
      const client: McpClientLike = hasCommand ? new McpClient(cfg) : new McpHttpClient(cfg);
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
        const toolName = namespacedToolName(cfg.name, tool.name);
        this.toolSpecs.push(buildToolSpec(toolName, cfg.name, tool.name, tool.description, tool.inputSchema, client));
      }
      logger.info(`MCP server "${cfg.name}" connected with ${tools.length} tool(s).`);
    }
  }
}

function buildToolSpec(
  toolName: string,
  serverName: string,
  remoteName: string,
  description: string | undefined,
  inputSchema: Record<string, any> | undefined,
  client: McpClientLike
): DynamicToolSpec {
  return {
    name: toolName,
    serverName,
    remoteName,
    // MCP standardization (0.14.0): the schema summary makes the model aware
    // of every parameter (including optional ones exampleArgs below doesn't
    // show), not just whatever happened to be in the free-text `description`
    // the server provided.
    describe: `[MCP: ${serverName}] ${description || `Calls the "${remoteName}" tool on the connected "${serverName}" MCP server.`}${summarizeSchemaForDescribe(inputSchema)}`,
    // Previously always `{}` regardless of the tool's real parameters — see
    // exampleArgsFromSchema()'s doc comment for why that was a bug, not a
    // design choice: the schema was fetched via tools/list and then simply
    // never read.
    exampleArgs: exampleArgsFromSchema(inputSchema),
    inputSchema,
    run: async (args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> => {
      const callId = nextCallId();
      const label = `MCP tool ${serverName}/${remoteName}(${summarizeArgs(args)})`;
      const approved = await ctx.requestCommandApproval(label, callId);
      if (!approved) {
        return { ok: false, content: 'The user did not approve this MCP tool call. Ask before proceeding, or try a different approach.' };
      }
      try {
        const result = await client.callTool(remoteName, args || {});
        // MCP standardization (0.14.0): non-text content blocks (images,
        // embedded resources) are carried through as attachments, shown to
        // the user, NOT inlined into the model-facing content — the model
        // gets a one-line heads-up instead of a useless placeholder or an
        // expensive base64 dump. See agent/types.ts's ToolResultAttachment.
        const attachmentNote =
          result.attachments && result.attachments.length > 0
            ? `\n\n[${result.attachments.length} non-text content block(s) (${[...new Set(result.attachments.map((a) => a.type))].join(', ')}) returned by this tool are shown to the user as attachment(s) — you were not given their raw content here.]`
            : '';
        return { ok: result.ok, content: `${result.content}${attachmentNote}`, attachments: result.attachments };
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
