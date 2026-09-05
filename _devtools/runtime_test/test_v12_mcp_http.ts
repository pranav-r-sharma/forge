// Runtime tests for the MCP "Streamable HTTP" transport (item: "MCP
// integration to integrate my custom built mcps" — many self-hosted/custom
// MCP servers are exposed over HTTP rather than as a local stdio child
// process, so this is the alternative transport alongside the existing
// stdio one). Mirrors test_v11.ts's MCP section: every test here spawns a
// REAL child process running fixtures/fake_mcp_http_server.js, a real
// Node `http` server speaking actual Streamable HTTP JSON-RPC, rather than
// mocking McpHttpClient — same "test against a real subprocess/real I/O"
// philosophy as the rest of this project's runtime tests.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { McpHttpClient } from '../../src/mcp/mcpHttpClient';
import { McpManager } from '../../src/mcp/mcpManager';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { runAgentTurn } from '../../src/agent/agentLoop';

// Same 2-argument-only `spawn` type-shim gap as mcpClient.ts's SpawnedProcess
// comment — cast through `any` at the call site rather than fighting it.
type SpawnedProcess = ReturnType<typeof spawn>;

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v12-test-'));
  return vscode.Uri.file(tmp);
}

const FAKE_MCP_HTTP_SERVER = path.resolve(__dirname, 'fixtures/fake_mcp_http_server.js');

/** Spawns fixtures/fake_mcp_http_server.js on an OS-assigned port and resolves once it reports it's listening, parsed off its stdout. */
function startFakeHttpServer(env: Record<string, string> = {}): Promise<{ url: string; child: SpawnedProcess; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = (spawn as any)(process.execPath, [FAKE_MCP_HTTP_SERVER], {
      env: { ...process.env, FAKE_MCP_HTTP_PORT: '0', ...env },
    }) as SpawnedProcess;

    let out = '';
    const timer = setTimeout(() => {
      reject(new Error(`fake_mcp_http_server.js did not report listening in time (stdout so far: ${out})`));
    }, 5000);

    const onData = (buf: Buffer) => {
      out += buf.toString('utf8');
      const m = /FAKE_MCP_HTTP_LISTENING (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        child.stdout?.removeListener('data', onData);
        resolve({ url: `http://127.0.0.1:${m[1]}/mcp`, child, stop: () => child.kill() });
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', (err: any) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================================
// mcp/mcpHttpClient.ts — direct client tests against a REAL HTTP server
// ============================================================================
async function testMcpHttpClientDirect() {
  const server = await startFakeHttpServer();
  try {
    const client = new McpHttpClient({ name: 'fake-http', url: server.url });
    await client.connect();

    const tools = await client.listTools();
    ok(
      tools.length === 3 && tools.some((t) => t.name === 'echo') && tools.some((t) => t.name === 'fail') && tools.some((t) => t.name === 'sse_echo'),
      `listTools() returns all three tools from the real HTTP server over a plain JSON response (got ${tools.map((t) => t.name).join(',')})`
    );

    const echoResult = await client.callTool('echo', { text: 'hello' });
    ok(echoResult.ok === true && echoResult.content === 'echo: hello', `callTool("echo") round-trips through a real HTTP request/response (got ${JSON.stringify(echoResult)})`);

    const failResult = await client.callTool('fail', {});
    ok(failResult.ok === false && /always fails/.test(failResult.content), 'a tool-level error (isError:true from the server) surfaces as {ok:false}, not a thrown exception');

    // ---- the SSE (text/event-stream) response path, distinct from the plain-JSON path above ----
    const sseResult = await client.callTool('sse_echo', { text: 'via sse' });
    ok(sseResult.ok === true && sseResult.content === 'sse echo: via sse', `callTool("sse_echo") correctly parses a text/event-stream response body's "data:" line (got ${JSON.stringify(sseResult)})`);

    client.dispose();
    let threwAfterDispose = false;
    try {
      await client.callTool('echo', { text: 'after dispose' });
    } catch {
      threwAfterDispose = true;
    }
    ok(threwAfterDispose, 'calling a disposed client rejects rather than hanging or silently succeeding');
  } finally {
    server.stop();
  }
}

// ============================================================================
// mcp/mcpHttpClient.ts — session id + custom header propagation
// ============================================================================
async function testMcpHttpClientAuthAndSession() {
  const server = await startFakeHttpServer({ FAKE_MCP_HTTP_REQUIRE_AUTH: '1' });
  try {
    const clientWithoutAuth = new McpHttpClient({ name: 'no-auth', url: server.url });
    let threw = false;
    let message = '';
    try {
      await clientWithoutAuth.connect();
    } catch (err: any) {
      threw = true;
      message = err.message;
    }
    ok(threw && /HTTP 401/.test(message), `a request without the required Authorization header fails with a clear HTTP-status-carrying error (got ${JSON.stringify(message)})`);

    const clientWithAuth = new McpHttpClient({ name: 'with-auth', url: server.url, headers: { Authorization: 'Bearer test-token' } });
    await clientWithAuth.connect();
    const tools = await clientWithAuth.listTools();
    ok(tools.length === 3, 'configured `headers` (e.g. an Authorization bearer token) are actually sent on every request, letting the handshake succeed against an auth-requiring server');
    clientWithAuth.dispose();
  } finally {
    server.stop();
  }
}

// ============================================================================
// mcp/mcpHttpClient.ts — error paths: unreachable server, malformed response
// ============================================================================
async function testMcpHttpClientErrorPaths() {
  // ---------- server unreachable (nothing listening on this port) ----------
  {
    const client = new McpHttpClient({ name: 'unreachable', url: 'http://127.0.0.1:1/mcp' });
    let threw = false;
    let message = '';
    try {
      await client.connect();
    } catch (err: any) {
      threw = true;
      message = err.message;
    }
    ok(threw && /unreachable/.test(message), `an unreachable HTTP server throws a clear, server-named error rather than hanging (got ${JSON.stringify(message)})`);
  }

  // ---------- malformed (unparsable) response body ----------
  {
    const server = await startFakeHttpServer({ FAKE_MCP_HTTP_MALFORMED: '1' });
    try {
      const client = new McpHttpClient({ name: 'malformed', url: server.url });
      await client.connect(); // initialize is deliberately exempted by the fixture, so the handshake itself still succeeds

      const tools = await client.listTools();
      ok(Array.isArray(tools) && tools.length === 0, 'listTools() against a server returning unparsable JSON degrades to [] rather than throwing — same leniency as the stdio client');

      let threw = false;
      let message = '';
      try {
        await client.callTool('echo', { text: 'x' });
      } catch (err: any) {
        threw = true;
        message = err.message;
      }
      ok(threw && /valid JSON/i.test(message), `callTool() against a server returning unparsable JSON throws a clear transport-level error (got ${JSON.stringify(message)})`);
    } finally {
      server.stop();
    }
  }
}

// ============================================================================
// mcp/mcpManager.ts — HTTP-configured server wired through exactly like a stdio one
// ============================================================================
async function testMcpManagerHttp() {
  const server = await startFakeHttpServer();
  try {
    const manager = new McpManager(() => [{ name: 'My HTTP Server!', url: server.url }]);
    await manager.start();
    const specs = manager.listToolSpecs();
    ok(specs.some((s) => s.name === 'mcp__My_HTTP_Server__echo'), `an HTTP server's tools are namespaced exactly like a stdio server's (mcp__<sanitized-server>__<tool> — 0.14.0's double-underscore convention) (got ${specs.map((s) => s.name).join(',')})`);
    const status = manager.status();
    ok(status.length === 1 && status[0].connected === true && status[0].toolCount === 3, `status() reports the HTTP server connected with its 3 tools (got ${JSON.stringify(status)})`);

    // ---- calling a tool through its DynamicToolSpec goes through the same approval gate as a stdio MCP tool ----
    const echoSpec = specs.find((s) => s.name === 'mcp__My_HTTP_Server__echo')!;
    const approvedCtx: any = { requestCommandApproval: async () => true };
    const approvedResult = await echoSpec.run({ text: 'via http manager' }, approvedCtx);
    ok(approvedResult.ok === true && approvedResult.content === 'echo: via http manager', 'an approved MCP-over-HTTP tool call executes and returns the remote server\'s result');

    const deniedCtx: any = { requestCommandApproval: async () => false };
    const deniedResult = await echoSpec.run({ text: 'nope' }, deniedCtx);
    ok(deniedResult.ok === false && /did not approve/i.test(deniedResult.content), 'a denied approval short-circuits before calling the remote HTTP server, and reports why');

    manager.disposeAll();
    ok(manager.listToolSpecs().length === 0, 'disposeAll() clears every tool spec from an HTTP-backed server too');
  } finally {
    server.stop();
  }
}

// ============================================================================
// mcp/mcpManager.ts — command/url validation: exactly one of the two must be set
// ============================================================================
async function testMcpManagerTransportValidation() {
  const server = await startFakeHttpServer();
  try {
    const manager = new McpManager(() => [
      { name: 'both-set', command: process.execPath, url: server.url }, // ambiguous -> skipped
      { name: 'neither-set' }, // ambiguous -> skipped
      { name: 'good-http', url: server.url },
    ]);
    await manager.start();
    ok(manager.listToolSpecs().some((s) => s.name.startsWith('mcp__good_http__')), 'the well-formed HTTP server still starts even though two sibling entries were ambiguous');
    const errors = manager.lastStartErrors();
    ok(errors.some((e) => /both-set/.test(e) && /both/.test(e)), `an entry setting both "command" and "url" is rejected with a clear "not both" error (got ${JSON.stringify(errors)})`);
    ok(errors.some((e) => /neither-set/.test(e) && /neither/.test(e)), `an entry setting neither "command" nor "url" is rejected with a clear "not neither" error (got ${JSON.stringify(errors)})`);
    manager.disposeAll();
  } finally {
    server.stop();
  }
}

// ============================================================================
// full agentLoop.ts integration: the model calls a real MCP-over-HTTP tool through runAgentTurn end-to-end
// ============================================================================
async function testAgentLoopIntegration() {
  const server = await startFakeHttpServer();
  try {
    const manager = new McpManager(() => [{ name: 'fakehttp', url: server.url }]);
    await manager.start();
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) return '```forge_action\n{"tool": "mcp__fakehttp__echo", "args": {"text": "from the agent"}}\n```';
        return 'All done — the MCP-over-HTTP tool echoed back successfully.';
      },
    };
    const deps: any = {
      ollama: fakeOllama,
      pendingEdits: new PendingEditManager(workspaceRoot),
      approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
      hooks: new HookRunner(workspaceRoot),
      codebaseSearch: async () => [],
      rememberFact: async () => ({ added: false }),
      chatMemorySearch: async () => [],
      backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
      mcpTools: manager.listToolSpecs(),
      workspaceRoot,
      workspaceName: 'test',
    };
    const cts = new vscode.CancellationTokenSource();
    await runAgentTurn([], 'echo something via mcp over http', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });
    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    ok(!!toolResult && toolResult.ok === true && /echo: from the agent/.test(toolResult.summary), `runAgentTurn actually invoked the real MCP-over-HTTP server end-to-end and got its echo back (got ${JSON.stringify(toolResult)})`);
    const final = events.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final');
    ok(!!final, 'the turn reached a final answer after the MCP-over-HTTP tool call');
    manager.disposeAll();
  } finally {
    server.stop();
  }
}

// ============================================================================
// main
// ============================================================================
async function main() {
  await testMcpHttpClientDirect();
  await testMcpHttpClientAuthAndSession();
  await testMcpHttpClientErrorPaths();
  await testMcpManagerHttp();
  await testMcpManagerTransportValidation();
  await testAgentLoopIntegration();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('Some MCP HTTP transport runtime tests FAILED.');
    process.exit(1);
  }
  console.log('All MCP HTTP transport runtime tests passed.');
}

main().catch((err) => {
  console.error('Uncaught error in test_v12_mcp_http.ts:', err);
  process.exit(1);
});
