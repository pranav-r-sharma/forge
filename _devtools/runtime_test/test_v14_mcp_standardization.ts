// ============================================================================
// MCP standardization (0.14.0) — native JSON Schema -> exampleArgs/describe,
// structured content-block splitting (text fed to the model vs. attachments
// shown to the user), the mcp__<server>__<tool> namespacing convention, and
// error-format parity between an MCP tool result and a built-in ToolResult.
//
// Runs against a REAL spawned child process (fixtures/fake_mcp_server_v14.js)
// — same "test against a real subprocess, not a mock" philosophy as
// test_v11.ts's MCP tests, kept in a separate fixture specifically so this
// file's new tool/schema/content-block shapes don't disturb test_v11.ts's
// own exact-tool-count assertions against fake_mcp_server.js.
// ============================================================================

import * as path from 'path';
import { McpManager, exampleArgsFromSchema, summarizeSchemaForDescribe, namespacedToolName } from '../../src/mcp/mcpManager';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
}

const FAKE_MCP_SERVER_V14 = path.resolve(__dirname, 'fixtures/fake_mcp_server_v14.js');

// ---------- pure helpers: exampleArgsFromSchema / summarizeSchemaForDescribe / namespacedToolName ----------

function testSchemaHelpers() {
  ok(namespacedToolName('github', 'search_issues') === 'mcp__github__search_issues', 'namespacedToolName uses the 0.14.0 double-underscore separator');
  ok(namespacedToolName('My Server!', 'echo') === 'mcp__My_Server__echo', 'namespacedToolName sanitizes each side independently before joining');

  ok(Object.keys(exampleArgsFromSchema(undefined)).length === 0, 'exampleArgsFromSchema(undefined) is an empty object, not a crash');
  ok(Object.keys(exampleArgsFromSchema({ type: 'object' })).length === 0, 'a schema with no "properties" produces an empty example (nothing to show)');

  const requiredSchema = { type: 'object', properties: { query: { type: 'string', description: 'what to search for' }, limit: { type: 'number' } }, required: ['query'] };
  const requiredExample = exampleArgsFromSchema(requiredSchema);
  ok(Object.keys(requiredExample).length === 1 && 'query' in requiredExample, `only the REQUIRED property is shown when required is non-empty, not every property (got ${JSON.stringify(requiredExample)})`);
  ok(typeof requiredExample.query === 'string' && requiredExample.query.length > 0, 'a required string property gets a non-empty placeholder, not an empty string');

  const noRequiredSchema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' }, d: { type: 'array' } } };
  const noRequiredExample = exampleArgsFromSchema(noRequiredSchema);
  ok(Object.keys(noRequiredExample).length === 3, `with no required properties at all, up to the first 3 are shown so the tool doesn't look argument-less (got ${JSON.stringify(noRequiredExample)})`);

  const enumSchema = { type: 'object', properties: { mode: { type: 'string', enum: ['fast', 'thorough'] } }, required: ['mode'] };
  ok(exampleArgsFromSchema(enumSchema).mode === 'fast', 'an enum property\'s example value is its first enum member, not a generic placeholder');

  const typedPlaceholders = exampleArgsFromSchema({ type: 'object', properties: { n: { type: 'number' }, ok: { type: 'boolean' }, list: { type: 'array' }, obj: { type: 'object' } }, required: ['n', 'ok', 'list', 'obj'] });
  ok(typedPlaceholders.n === 0 && typedPlaceholders.ok === false && Array.isArray(typedPlaceholders.list) && typeof typedPlaceholders.obj === 'object', `each JSON Schema type gets a type-appropriate placeholder, not a one-size-fits-all string (got ${JSON.stringify(typedPlaceholders)})`);

  ok(summarizeSchemaForDescribe(undefined) === '', 'summarizeSchemaForDescribe(undefined) is an empty string, not a placeholder — callers append it unconditionally');
  const summary = summarizeSchemaForDescribe(requiredSchema);
  ok(summary.includes('query: string') && summary.includes('limit?: number'), `the schema summary marks the required property plainly and the optional one with "?" (got ${JSON.stringify(summary)})`);
}

// ---------- integration: real spawned server, schema-derived exampleArgs/describe, content-block splitting ----------

async function testMcpStandardizationIntegration() {
  const manager = new McpManager(() => [{ name: 'v14fake', command: process.execPath, args: [FAKE_MCP_SERVER_V14] }]);
  await manager.start();
  try {
    const specs = manager.listToolSpecs();
    ok(specs.length === 4, `all 4 tools from the fixture are registered (got ${specs.map((s) => s.name).join(',')})`);

    // ---- schema -> exampleArgs/describe actually flows through the real listTools()/buildToolSpec() path, not just the pure helper in isolation ----
    const searchSpec = specs.find((s) => s.name === 'mcp__v14fake__search')!;
    ok(!!searchSpec, 'the "search" tool is namespaced and registered');
    ok(searchSpec.inputSchema?.required?.[0] === 'query', 'the real JSON Schema from tools/list is stored verbatim on the DynamicToolSpec (not discarded after being fetched, which was the pre-0.14.0 bug)');
    ok(Object.keys(searchSpec.exampleArgs).length === 1 && 'query' in searchSpec.exampleArgs, `the tool's exampleArgs (what the model actually sees in the system prompt) is synthesized from its real schema, not a bare {} (got ${JSON.stringify(searchSpec.exampleArgs)})`);
    ok(searchSpec.describe.includes('Parameters:') && searchSpec.describe.includes('limit?: number'), `the tool's describe string names its parameters, including the optional one exampleArgs alone wouldn't show (got ${JSON.stringify(searchSpec.describe)})`);
    ok(searchSpec.serverName === 'v14fake' && searchSpec.remoteName === 'search', 'serverName/remoteName are stored directly on the spec rather than needing to be re-parsed out of the namespaced tool name');

    const approvedCtx: any = { requestCommandApproval: async () => true };

    // ---- text-only tool: attachments stays undefined, content is unchanged from the pre-0.14.0 shape (no regression for the common case) ----
    const textOnlySpec = specs.find((s) => s.name === 'mcp__v14fake__text_only')!;
    const textOnlyResult = await textOnlySpec.run({}, approvedCtx);
    ok(textOnlyResult.ok === true && textOnlyResult.content === 'just text', `an all-text tool result is unaffected by the content-block split (got ${JSON.stringify(textOnlyResult)})`);
    ok(textOnlyResult.attachments === undefined, 'a text-only result has no attachments array at all — not an empty array, undefined, so callers can cheaply check `if (result.attachments)`');

    // ---- image content block: becomes an attachment, NOT inlined as raw base64 into the model-facing content ----
    const imageSpec = specs.find((s) => s.name === 'mcp__v14fake__with_image')!;
    const imageResult = await imageSpec.run({}, approvedCtx);
    ok(imageResult.ok === true, 'the with_image tool call succeeds');
    ok(imageResult.attachments?.length === 1 && imageResult.attachments[0].type === 'image', `the image content block becomes exactly one attachment of type "image" (got ${JSON.stringify(imageResult.attachments)})`);
    ok(imageResult.attachments![0].dataBase64 && imageResult.attachments![0].dataBase64!.length > 0 && imageResult.attachments![0].mimeType === 'image/png', 'the attachment carries the actual base64 data and mimeType, not just a placeholder');
    ok(imageResult.content.includes('here is a chart'), 'the text block ("here is a chart") still reaches the model-facing content normally');
    ok(!imageResult.content.includes(imageResult.attachments![0].dataBase64!), 'the raw base64 image payload is NEVER inlined into the model-facing content — that would be an expensive and unreadable way to hand a local model a binary blob');
    ok(/non-text content block/i.test(imageResult.content), 'the model-facing content includes a one-line heads-up that a non-text attachment exists, so it isn\'t silently unaware something was returned');

    // ---- embedded resource content block: uri/text/mimeType survive, normalized the same way an image attachment is ----
    const resourceSpec = specs.find((s) => s.name === 'mcp__v14fake__with_resource')!;
    const resourceResult = await resourceSpec.run({}, approvedCtx);
    ok(resourceResult.attachments?.length === 1 && resourceResult.attachments[0].type === 'resource', `the embedded resource block becomes one attachment of type "resource" (got ${JSON.stringify(resourceResult.attachments)})`);
    ok(resourceResult.attachments![0].uri === 'file:///report.txt' && resourceResult.attachments![0].text === 'full report contents' && resourceResult.attachments![0].mimeType === 'text/plain', `the resource's nested uri/text/mimeType are all normalized onto the flat attachment shape (got ${JSON.stringify(resourceResult.attachments)})`);

    // ---- error-format parity: a denied MCP approval and a tool-level MCP failure both come back as the exact same {ok:false, content} shape a built-in tool's ToolResult uses — no special-casing needed downstream ----
    const deniedCtx: any = { requestCommandApproval: async () => false };
    const deniedResult = await searchSpec.run({ query: 'x' }, deniedCtx);
    ok(deniedResult.ok === false && typeof deniedResult.content === 'string' && deniedResult.content.length > 0, 'a denied MCP tool call returns {ok:false, content: "..."} — the identical shape a built-in tool\'s denial/failure uses, so agentLoop.ts needs no MCP-specific branch to render it');
    // Transport-level failure -> {ok:false, content} parity (the try/catch in buildToolSpec()'s run()) is already covered by test_v11.ts's "bad server config" case, which exercises that identical catch block.
  } finally {
    manager.disposeAll();
  }
}

async function main() {
  testSchemaHelpers();
  await testMcpStandardizationIntegration();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log('Some v0.14.0 MCP standardization runtime tests FAILED.');
    process.exit(1);
  } else {
    console.log('All v0.14.0 MCP standardization runtime tests passed.');
  }
}

main().catch((err) => {
  console.error('Uncaught error in test_v14_mcp_standardization.ts:', err);
  process.exit(1);
});
