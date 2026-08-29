#!/usr/bin/env node
// A minimal, real MCP server speaking newline-delimited JSON-RPC 2.0 over
// stdio, used by test_v11.ts to exercise McpClient/McpManager against an
// actual child process (not a mock) — same "test against real subprocesses"
// philosophy as the rest of this project's runtime tests (e.g. the real
// commandTool.ts child-process tests in test_v10.ts).
//
// Supports exactly what Forge's client needs: initialize, notifications/
// initialized (ignored), tools/list (returns "echo" and "fail"), and
// tools/call (echoes its "text" arg back, or returns isError:true for "fail").
// Env var FAKE_MCP_PROTOCOL_VERSION lets a test simulate a server that
// negotiates a different protocol version than the client asked for.

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: process.env.FAKE_MCP_PROTOCOL_VERSION || msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '1.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    return; // no response expected for a notification
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'fail', description: 'Always reports a tool-level error.', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    if (name === 'fail') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'the fail tool always fails' }] } });
      return;
    }
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown tool "${name}"` } });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method "${msg.method}"` } });
  }
}
