#!/usr/bin/env node
// A second minimal real MCP server (stdio), separate from
// fake_mcp_server.js so 0.14.0's new content-block/schema assertions don't
// have to touch that file's existing tool count/list assertions (test_v11.ts
// asserts exactly 2 tools from fake_mcp_server.js) — same "test against a
// real subprocess" philosophy, just a different fixture exposing a richer
// set of tools/schemas/content-block shapes for MCP standardization
// (0.14.0) to exercise:
//   - "search": a schema with a REQUIRED string param and an optional number
//     param, for exampleArgsFromSchema()/summarizeSchemaForDescribe() to
//     synthesize a non-empty example/parameter summary from.
//   - "with_image": returns a `content` array containing a `text` block AND
//     an `image` block (base64 `data`+`mimeType`) — exercises the
//     text/attachment split.
//   - "with_resource": returns a `content` array containing an embedded
//     `resource` block (`{type:'resource', resource:{uri,text,mimeType}}`).
//   - "text_only": a normal all-text tool, for confirming attachments stays
//     undefined when there's nothing but text (no behavior change from pre-
//     0.14.0 for the common case).

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

// A tiny valid 1x1 PNG, base64-encoded — just needs to be SOME base64 text
// for the attachment round-trip; nothing ever actually decodes/renders it in
// this test.
const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server-v14', version: '1.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'search',
            description: 'Searches for something.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'what to search for' },
                limit: { type: 'number' },
              },
              required: ['query'],
            },
          },
          { name: 'with_image', description: 'Returns text plus an image attachment.', inputSchema: { type: 'object' } },
          { name: 'with_resource', description: 'Returns an embedded resource block.', inputSchema: { type: 'object' } },
          { name: 'text_only', description: 'Returns plain text only.', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === 'search') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'no results' }] } });
      return;
    }
    if (name === 'with_image') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            { type: 'text', text: 'here is a chart' },
            { type: 'image', data: FAKE_PNG_BASE64, mimeType: 'image/png' },
          ],
        },
      });
      return;
    }
    if (name === 'with_resource') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [
            {
              type: 'resource',
              resource: { uri: 'file:///report.txt', text: 'full report contents', mimeType: 'text/plain' },
            },
          ],
        },
      });
      return;
    }
    if (name === 'text_only') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'just text' }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown tool "${name}"` } });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method "${msg.method}"` } });
  }
}
