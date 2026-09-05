#!/usr/bin/env node
// A minimal, real MCP server speaking the MCP "Streamable HTTP" transport
// (JSON-RPC 2.0 POSTed to a single endpoint) over Node's built-in `http`
// module, used by test_v12_mcp_http.ts to exercise McpHttpClient/McpManager
// against an actual HTTP server (not a mock) — same "test against real I/O"
// philosophy as fake_mcp_server.js's real stdio child process.
//
// Supports exactly what Forge's HTTP client needs: initialize (issuing an
// Mcp-Session-Id the client is expected to echo back), notifications/
// initialized (ignored, 202-with-no-body), tools/list (returns "echo",
// "fail", and "sse_echo"), and tools/call. Two response shapes are
// exercised deliberately:
//   - every tool except "sse_echo" responds with a plain application/json body.
//   - "sse_echo" responds with a text/event-stream body (one "data:" event
//     carrying the JSON-RPC response), covering the SSE response path.
// Env var FAKE_MCP_HTTP_REQUIRE_AUTH=1 makes every request require
// "Authorization: Bearer test-token", returning 401 otherwise — used to
// test that configured `headers` are actually sent.
// Env var FAKE_MCP_HTTP_MALFORMED=1 makes every request past the initial
// handshake return deliberately broken (unparsable) JSON, for the
// malformed-response error-path test.

const http = require('http');

const PORT = parseInt(process.env.FAKE_MCP_HTTP_PORT || '0', 10);
const REQUIRE_AUTH = process.env.FAKE_MCP_HTTP_REQUIRE_AUTH === '1';
const MALFORMED = process.env.FAKE_MCP_HTTP_MALFORMED === '1';
const SESSION_ID = 'fake-session-abc123';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION_ID });
  res.end(body);
}

function sendSse(res, obj) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': SESSION_ID });
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  res.end();
}

function handleRequest(msg, res) {
  if (MALFORMED && msg.method !== 'initialize' && msg.id !== undefined && msg.id !== null) {
    // Simulate a server that returns a broken body for anything past the handshake — used to test the client's malformed-response error path.
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION_ID });
    res.end('{ this is not valid json ]');
    return;
  }
  if (msg.method === 'initialize') {
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params && msg.params.protocolVersion ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-http-server', version: '1.0' },
      },
    });
  }
  if (msg.method === 'tools/list') {
    return sendJson(res, 200, {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echoes back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'fail', description: 'Always reports a tool-level error.', inputSchema: { type: 'object' } },
          { name: 'sse_echo', description: 'Echoes back the given text, but over an SSE response.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        ],
      },
    });
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'fail') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'the fail tool always fails' }] } });
    }
    if (name === 'echo') {
      return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] } });
    }
    if (name === 'sse_echo') {
      return sendSse(res, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `sse echo: ${args.text ?? ''}` }] } });
    }
    return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown tool "${name}"` } });
  }
  if (msg.id !== undefined && msg.id !== null) {
    return sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method "${msg.method}"` } });
  }
  // A notification (no id, e.g. notifications/initialized) — per spec, 202 Accepted with no body.
  res.writeHead(202, { 'Mcp-Session-Id': SESSION_ID });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  if (REQUIRE_AUTH && req.headers['authorization'] !== 'Bearer test-token') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handleRequest(msg, res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  // Printed on its own line so the test harness (which spawns this as a
  // child process) can parse out the actual bound port when PORT=0.
  console.log(`FAKE_MCP_HTTP_LISTENING ${addr.port}`);
});
