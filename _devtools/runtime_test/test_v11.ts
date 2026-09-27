// Runtime tests for the 0.11.0 round: every item from the "repo-aware
// retrieval / edit-fidelity / tool-protocol-reliability / inference-time
// accuracy" backlog (structural chunking, import-graph augmentation,
// open-tab + recency retrieval weighting, fuzzy whitespace-tolerant
// search/replace, advisory balance-regression checking, constrained/
// structured-output decoding, plan-first, self-critique, best-of-N), the
// prompt-prefix-stability (KV-cache) fix, and native MCP client integration.
// Each section is independently runnable, mirroring every previous
// test_v*.ts file's ok()/main() harness. The MCP section spawns a REAL child
// process (fixtures/fake_mcp_server.js) speaking actual JSON-RPC over stdio
// rather than mocking McpClient — same "test against a real subprocess"
// philosophy as test_v10.ts's commandTool.ts tests.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chunkFileStructurally } from '../../src/indexing/chunker';
import { extractImportSpecifiers, resolveImportPath, buildImportGraph } from '../../src/indexing/importGraph';
import { WorkspaceIndex } from '../../src/indexing/workspaceIndex';
import { OllamaClient } from '../../src/ollama/client';
import {
  writeFileTool,
  findFuzzyLineMatches,
  detectBalanceRegression,
} from '../../src/tools/fileTools';
import { STRUCTURED_RESPONSE_SCHEMA, parseStructuredResponse } from '../../src/agent/structuredOutput';
import { generatePlanFirst, renderPlanFirstForPrompt } from '../../src/agent/planFirst';
import { shouldCritique, critiqueEdit } from '../../src/agent/selfCritique';
import { sampleBestOfNForRewrite, MIN_LINES_FOR_BEST_OF_N } from '../../src/agent/bestOfN';
import { buildSystemPrompt, buildTurnContextPrefix } from '../../src/agent/systemPrompt';
import { runAgentTurn, resolveModelResponse } from '../../src/agent/agentLoop';
import { McpClient } from '../../src/mcp/mcpClient';
import { McpManager } from '../../src/mcp/mcpManager';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent, ToolCall } from '../../src/agent/types';
import { getConfig } from '../../src/util/config';
import { ChatMessage } from '../../src/ollama/types';

const vs = vscode as any;

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v11-test-'));
  return vscode.Uri.file(tmp);
}

const FAKE_MCP_SERVER = path.resolve(__dirname, 'fixtures/fake_mcp_server.js');

// ============================================================================
// indexing/chunker.ts — structural (boundary-aware) chunking
// ============================================================================
function testChunkerStructural() {
  // ---------- prefers a declaration boundary over an arbitrary line count ----------
  {
    const fnBody = Array.from({ length: 25 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const text = `function first() {\n${fnBody}\n}\n\nfunction second() {\n${fnBody}\n}\n`;
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks.length === 2, `two top-level functions each >= minLines produce two chunks (got ${chunks.length})`);
    ok(chunks[0].text.includes('function first'), 'first chunk starts at the first function');
    ok(chunks[1].text.trimStart().startsWith('function second'), 'second chunk starts exactly at the second function boundary, not mid-body');
  }

  // ---------- decorator stays attached to the declaration it precedes ----------
  {
    const filler = Array.from({ length: 22 }, (_, i) => `  field${i} = ${i};`).join('\n');
    const text = `class Base {\n${filler}\n}\n\n@Component({ selector: 'x' })\nclass Widget {\n${filler}\n}\n`;
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks.length === 2, 'a decorated class after a long enough first chunk still splits into two chunks');
    ok(chunks[1].text.trimStart().startsWith('@Component'), 'the chunk boundary falls at the decorator line, not the class line after it — the decorator stays attached to its declaration');
  }

  // ---------- Python def/class boundaries ----------
  {
    const body = Array.from({ length: 22 }, (_, i) => `    x = ${i}`).join('\n');
    const text = `class Foo:\n${body}\n\ndef bar():\n${body}\n`;
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks.length === 2, 'Python class/def boundaries are also detected (got ' + chunks.length + ' chunks)');
    ok(chunks[1].text.trimStart().startsWith('def bar'), 'second chunk starts at the def boundary');
  }

  // ---------- minLines: many tiny declarations don't flood into a chunk per declaration ----------
  {
    const text = Array.from({ length: 30 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks.length < 30, `a barrel-like file of 30 one-line functions does not produce 30 tiny chunks (got ${chunks.length}, minLines should merge them)`);
    ok(chunks.every((c) => c.endLine - c.startLine + 1 >= 20 || c === chunks[chunks.length - 1]), 'every chunk except possibly the last respects the minLines floor');
  }

  // ---------- maxLines: falls back to a forced cut when no boundary appears in time ----------
  {
    const text = Array.from({ length: 400 }, (_, i) => `  console.log(${i}); // no declarations here at all`).join('\n');
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks.length === Math.ceil(400 / 160), `a boundary-free file still gets fixed-window chunks at maxLines (got ${chunks.length}, expected ${Math.ceil(400 / 160)})`);
    ok(chunks[0].endLine - chunks[0].startLine + 1 === 160, 'the forced-cut chunk is exactly maxLines long');
  }

  // ---------- startLine/endLine are 1-based and contiguous across chunks ----------
  {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkFileStructurally(text, 160, 20);
    ok(chunks[0].startLine === 1, 'first chunk starts at line 1 (1-based)');
    let contiguous = true;
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].startLine !== chunks[i - 1].endLine + 1) contiguous = false;
    }
    ok(contiguous, 'chunk line ranges are contiguous with no gaps or overlaps');
  }
}

// ============================================================================
// indexing/importGraph.ts — lightweight import-graph traversal
// ============================================================================
function testImportGraph() {
  // ---------- extractImportSpecifiers: JS/TS + Python forms ----------
  {
    const text = [
      `import { foo } from './helpers/foo';`,
      `import bar from "../bar";`,
      `const baz = require('./baz');`,
      `import 'side-effect-only';`,
      `from .models import User`,
      `import utils.strings`,
    ].join('\n');
    const specs = extractImportSpecifiers(text);
    ok(specs.includes('./helpers/foo'), 'extracts a named ES import specifier');
    ok(specs.includes('../bar'), 'extracts a default ES import specifier');
    ok(specs.includes('./baz'), 'extracts a CommonJS require() specifier');
    ok(specs.includes('side-effect-only'), 'extracts a side-effect-only import specifier');
    ok(specs.includes('.models'), 'extracts a Python "from .x import y" specifier');
    ok(specs.includes('utils.strings'), 'extracts a Python bare "import x.y" specifier');
  }

  // ---------- resolveImportPath: relative-only resolution against known files ----------
  {
    const known = new Set(['src/a.ts', 'src/helpers/foo.ts', 'src/bar.ts', 'src/nested/index.ts']);
    ok(resolveImportPath('./helpers/foo', 'src/a.ts', known) === 'src/helpers/foo.ts', 'resolves a relative specifier by trying the .ts extension');
    ok(resolveImportPath('../bar', 'src/helpers/foo.ts', known) === 'src/bar.ts', 'resolves ".." parent-directory traversal correctly');
    ok(resolveImportPath('./nested', 'src/a.ts', known) === 'src/nested/index.ts', 'resolves a directory specifier to its index.ts');
    ok(resolveImportPath('some-npm-package', 'src/a.ts', known) === undefined, 'a bare (non-relative) specifier is deliberately left unresolved — see importGraph.ts doc comment');
    ok(resolveImportPath('./does-not-exist', 'src/a.ts', known) === undefined, 'a relative specifier with no matching known file resolves to undefined rather than guessing');
  }

  // ---------- buildImportGraph: whole-workspace graph, self-imports excluded, dedup applied ----------
  {
    const files = [
      { path: 'src/a.ts', text: `import { f } from './b';\nimport { f2 } from './b';\nimport './a';` },
      { path: 'src/b.ts', text: `export const f = 1; export const f2 = 2;` },
      { path: 'src/c.ts', text: `// no imports here` },
    ];
    const graph = buildImportGraph(files);
    ok(JSON.stringify(graph.get('src/a.ts')) === JSON.stringify(['src/b.ts']), `a.ts's import graph entry is exactly ["src/b.ts"] — deduped despite two imports of it and self-import excluded (got ${JSON.stringify(graph.get('src/a.ts'))})`);
    ok(!graph.has('src/c.ts'), 'a file with no resolvable imports has no entry in the graph at all');
  }
}

// ============================================================================
// indexing/workspaceIndex.ts — open-tab / recency retrieval weighting + import-graph augmentation + cache versioning
// ============================================================================
async function testWorkspaceIndexWeighting() {
  const fakeOllama: any = {
    embed: async (_model: string, text: string) => {
      // The query always embeds to [1, 0]; chunk text is tagged with its
      // intended cosine similarity via a "SIM:<n>" marker so the test can
      // control ranking precisely without a real embedding model.
      if (text === 'query') return [1, 0];
      const m = /SIM:([0-9.]+)/.exec(text);
      const sim = m ? parseFloat(m[1]) : 1;
      return [sim, Math.sqrt(Math.max(0, 1 - sim * sim))];
    },
  };

  // ---------- open-tab boost flips a close ranking, but never an irrelevant chunk over a relevant one ----------
  {
    const openPaths = new Set<string>();
    const index = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), undefined, () => 'fake-model', () => openPaths);
    (index as any).embeddingsAvailable = true;
    (index as any).chunks = [
      { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1', text: 'SIM:1.0 exact match', vector: [1, 0] },
      { path: 'b.ts', startLine: 1, endLine: 5, hash: 'h2', text: 'SIM:0.99 close second', vector: [0.99, Math.sqrt(1 - 0.99 * 0.99)] },
      { path: 'irrelevant.ts', startLine: 1, endLine: 5, hash: 'h3', text: 'SIM:0.5 unrelated', vector: [0.5, Math.sqrt(1 - 0.25)] },
    ];

    const before = await index.search('query', 3);
    ok(before[0].path.startsWith('a.ts'), 'without any open tabs, the higher base-similarity chunk (a.ts) ranks first');

    openPaths.add('b.ts');
    const after = await index.search('query', 3);
    ok(after[0].path.startsWith('b.ts'), 'once b.ts is an open tab, its small boost is enough to overtake a.ts\'s narrow similarity lead');
    ok(after.find((r) => r.path.startsWith('irrelevant.ts'))!.score < after[0].score, 'the open-tab boost never lets a genuinely irrelevant open file outrank the top relevant result');
  }

  // ---------- recently-touched boost, via markRecentlyTouched(), also flips a close ranking ----------
  {
    const index = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), undefined, () => 'fake-model');
    (index as any).embeddingsAvailable = true;
    (index as any).chunks = [
      { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1', text: 'SIM:1.0', vector: [1, 0] },
      { path: 'd.ts', startLine: 1, endLine: 5, hash: 'h2', text: 'SIM:0.98', vector: [0.98, Math.sqrt(1 - 0.98 * 0.98)] },
    ];
    const before = await index.search('query', 2);
    ok(before[0].path.startsWith('a.ts'), 'before any recent edit, a.ts (higher similarity) ranks first');
    index.markRecentlyTouched('d.ts');
    const after = await index.search('query', 2);
    ok(after[0].path.startsWith('d.ts'), 'markRecentlyTouched() on d.ts is enough to overtake a.ts\'s narrow similarity lead');

    // A touch older than the 30-minute window no longer counts.
    (index as any).recentlyTouched.set('d.ts', Date.now() - 31 * 60 * 1000);
    const stale = await index.search('query', 2);
    ok(stale[0].path.startsWith('a.ts'), 'a recency boost older than the 30-minute window no longer applies — a.ts ranks first again');
  }

  // ---------- import-graph augmentation: pulls in the top hit's imported file, labeled, without duplicating an already-present result ----------
  {
    const index = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), undefined, () => 'fake-model');
    (index as any).embeddingsAvailable = true;
    (index as any).chunks = [
      { path: 'main.ts', startLine: 1, endLine: 5, hash: 'h1', text: 'SIM:1.0 top hit', vector: [1, 0] },
      { path: 'helper.ts', startLine: 1, endLine: 5, hash: 'h2', text: 'SIM:0.1 unrelated on its own', vector: [0.1, Math.sqrt(1 - 0.01)] },
      { path: 'other.ts', startLine: 1, endLine: 5, hash: 'h3', text: 'SIM:0.05 also unrelated', vector: [0.05, Math.sqrt(1 - 0.0025)] },
    ];
    (index as any).importGraph = new Map([['main.ts', ['helper.ts']]]);

    const results = await index.search('query', 1); // k=1 so helper.ts would never make the top-k on similarity alone
    ok(results.length === 2, `search() appended the imported file beyond the requested k=1 (got ${results.length} results)`);
    const pulled = results.find((r) => r.path.startsWith('helper.ts'));
    ok(!!pulled, 'helper.ts (imported by the top hit main.ts) is present in the results despite low standalone similarity');
    ok(!!pulled && pulled.snippet.includes('[Pulled in because main.ts imports this file]'), 'the pulled-in result is clearly labeled with which file imports it');

    // Now make helper.ts ALSO rank in the top-k on its own merit — it must not be duplicated.
    (index as any).chunks[1] = { path: 'helper.ts', startLine: 1, endLine: 5, hash: 'h2', text: 'SIM:0.9 now genuinely relevant', vector: [0.9, Math.sqrt(1 - 0.81)] };
    const results2 = await index.search('query', 2);
    const helperCount = results2.filter((r) => r.path.startsWith('helper.ts')).length;
    ok(helperCount === 1, `once helper.ts already ranks in the top-k on its own merit, it is not duplicated by the import-pull-in step (got ${helperCount} copies)`);
  }

  // ---------- cache versioning: an old (pre-structural-chunking) cache is ignored, not loaded ----------
  {
    const storageUri = freshWorkspace();
    const cacheUri = vscode.Uri.joinPath(storageUri, 'forge-index.json');
    await vscode.workspace.fs.createDirectory(storageUri);

    await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(JSON.stringify({ version: 1, embeddingModel: 'fake-model', chunks: [{ path: 'x.ts', startLine: 1, endLine: 2, hash: 'h', text: 'old', vector: [1, 0] }] }), 'utf8'));
    const idxOldVersion = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), storageUri, () => 'fake-model');
    await idxOldVersion.loadCache();
    ok(idxOldVersion.status().total === 0, 'a version:1 (pre-0.11.0) cache file is not loaded — its chunk boundaries are incompatible with the new structural chunker');

    await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(JSON.stringify({ version: 2, embeddingModel: 'a-different-model', chunks: [{ path: 'x.ts', startLine: 1, endLine: 2, hash: 'h', text: 'old', vector: [1, 0] }] }), 'utf8'));
    const idxWrongModel = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), storageUri, () => 'fake-model');
    await idxWrongModel.loadCache();
    ok(idxWrongModel.status().total === 0, 'a version:2 cache built with a different embedding model is also ignored (model changed = re-embed needed)');

    await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(JSON.stringify({ version: 2, embeddingModel: 'fake-model', chunks: [{ path: 'x.ts', startLine: 1, endLine: 2, hash: 'h', text: 'current', vector: [1, 0] }] }), 'utf8'));
    const idxMatching = new WorkspaceIndex(fakeOllama, vscode.Uri.file('/ws'), storageUri, () => 'fake-model');
    await idxMatching.loadCache();
    ok(idxMatching.status().total === 1, 'a version:2 cache with a matching embedding model loads successfully');
  }
}

// ============================================================================
// tools/fileTools.ts — fuzzy whitespace-tolerant search/replace + balance-regression advisory
// ============================================================================
async function testFuzzyMatchingAndBalanceRegression() {
  // ---------- findFuzzyLineMatches: whitespace/indentation-only differences still match ----------
  {
    const existing = 'function f() {\n\t\treturn 1;\n}\n';
    const matches = findFuzzyLineMatches(existing, '    return 1;');
    ok(matches.length === 1, `a tabs-vs-spaces-only difference is found as exactly one fuzzy match (got ${matches.length})`);
  }
  {
    // Two identical (once normalized) lines elsewhere in the file -> ambiguous.
    const existing = 'if (a) {\n  doThing();\n}\nif (b) {\n  doThing();\n}\n';
    const matches = findFuzzyLineMatches(existing, 'doThing();');
    ok(matches.length === 2, `a line that repeats verbatim elsewhere in the file reports every match, letting the caller detect ambiguity (got ${matches.length})`);
  }
  {
    // Deliberate scope limit: a sub-line fragment of a longer real line must NOT match.
    const existing = 'const value = computeSomethingLong(a, b, c);\n';
    const matches = findFuzzyLineMatches(existing, 'computeSomethingLong(a, b, c)');
    ok(matches.length === 0, 'a sub-line fragment (not the whole line) is correctly NOT matched by the whole-line fuzzy fallback');
  }
  {
    const matches = findFuzzyLineMatches('\n\n\n', '\n\n');
    ok(matches.length === 0, 'a search block that is entirely blank once normalized refuses to match anything, rather than "matching" the first blank lines');
  }

  // ---------- writeFileTool end-to-end: fuzzy fallback applies, is advisory-labeled, and rejects ambiguity ----------
  {
    const existing = 'class Foo {\n\tgetValue() {\n\t\treturn 42;\n\t}\n}\n';
    let written: any;
    const ctx: any = {
      workspaceRoot: vscode.Uri.file('/ws'),
      readEffective: async () => existing,
      proposeEdit: async (edit: any) => { written = edit; return { id: 'e1', applied: true }; },
    };
    const result = await writeFileTool({ path: 'foo.ts', search: '    return 42;', replace: '    return 43;' }, ctx);
    ok(result.ok === true, 'writeFileTool succeeds via the fuzzy fallback when byte-exact search fails but whitespace-normalized search matches once');
    ok(/whitespace\/indentation/i.test(result.content), 'the tool result carries an advisory note explaining the fuzzy match was used');
    ok(!!written && written.newText.includes('return 43;') && !written.newText.includes('return 42;'), 'the edit was actually applied at the fuzzily-matched location');
  }
  {
    const existing = 'if (a) {\n  same();\n}\nif (b) {\n  same();\n}\n';
    const ctx: any = { workspaceRoot: vscode.Uri.file('/ws'), readEffective: async () => existing, proposeEdit: async () => ({ id: 'e1', applied: true }) };
    const result = await writeFileTool({ path: 'foo.ts', search: '    same();', replace: '    changed();' }, ctx);
    ok(result.ok === false && /matches 2 places/.test(result.content), 'writeFileTool refuses an ambiguous fuzzy match (2+ locations) rather than guessing which one');
  }
  {
    const existing = 'totally different content here\n';
    const ctx: any = { workspaceRoot: vscode.Uri.file('/ws'), readEffective: async () => existing, proposeEdit: async () => ({ id: 'e1', applied: true }) };
    const result = await writeFileTool({ path: 'foo.ts', search: 'nothing like this exists', replace: 'x' }, ctx);
    ok(result.ok === false && /whitespace-tolerant match/i.test(result.content), 'writeFileTool\'s error message mentions the fuzzy attempt was also tried and failed, not just the byte-exact one');
  }

  // ---------- detectBalanceRegression: advisory-only, string/comment-unaware, only fires on a clean-before/broken-after transition ----------
  {
    ok(detectBalanceRegression('function f() { return 1; }', 'function f() { return 1 }') === undefined, 'balanced before and after -> no advisory');
    const flagged = detectBalanceRegression('function f() { return 1; }', 'function f() { return 1;');
    ok(!!flagged && /curly braces/.test(flagged), 'a file that goes from balanced to unbalanced curly braces is flagged, naming the bracket type');
    // Parens are already unbalanced before the edit (one "(" with no ")"),
    // so the before===0 gate never even considers them; curly braces stay
    // balanced on both sides. Net result: no advisory for either type.
    ok(detectBalanceRegression('function f( { return 1; }', 'function f( { return 1; } // comment') === undefined, 'a file that was ALREADY unbalanced before the edit (parens) is never flagged for that pre-existing issue (the before===0 gate only watches for a NEW regression)');
  }

  // ---------- writeFileTool surfaces the balance advisory for a full-content rewrite, not just search/replace ----------
  {
    const existing = 'function f() {\n  return 1;\n}\n';
    const ctx: any = { workspaceRoot: vscode.Uri.file('/ws'), readEffective: async () => existing, proposeEdit: async () => ({ id: 'e1', applied: true }) };
    const result = await writeFileTool({ path: 'foo.ts', content: 'function f() {\n  return 1;\n' }, ctx); // dropped the closing brace
    ok(result.ok === true && /unbalanced/i.test(result.content), 'a full-content rewrite that drops a closing brace still gets flagged by the same advisory, and the edit still succeeds (advisory, not a block)');
  }
}

// ============================================================================
// agent/structuredOutput.ts + agentLoop.ts's resolveModelResponse — constrained/structured decoding with graceful fallback
// ============================================================================
function testStructuredOutput() {
  ok(STRUCTURED_RESPONSE_SCHEMA.required[0] === 'response_type', 'the schema requires response_type as its discriminator field');

  {
    const parsed = parseStructuredResponse(JSON.stringify({ response_type: 'tool_call', tool: 'read_file', args: { path: 'x.ts' } }));
    ok(!!parsed?.call && parsed.call.tool === 'read_file' && parsed.call.args.path === 'x.ts', 'a well-formed tool_call envelope parses into a ToolCall');
  }
  {
    const parsed = parseStructuredResponse(JSON.stringify({ response_type: 'final_answer', final_answer: 'All done.' }));
    ok(parsed?.finalText === 'All done.', 'a well-formed final_answer envelope parses into finalText');
  }
  ok(parseStructuredResponse('not json at all') === undefined, 'invalid JSON returns undefined rather than throwing');
  ok(parseStructuredResponse(JSON.stringify({ foo: 'bar' })) === undefined, 'JSON missing response_type returns undefined');
  ok(parseStructuredResponse(JSON.stringify({ response_type: 'tool_call' })) === undefined, 'a tool_call envelope missing the "tool" field returns undefined rather than guessing');
  {
    const parsed = parseStructuredResponse(JSON.stringify({ response_type: 'tool_call', tool: 'x', args: 'not-an-object' }));
    ok(!!parsed?.call && JSON.stringify(parsed.call.args) === '{}', 'a tool_call envelope with a malformed args value falls back to {} rather than crashing');
  }

  // ---------- resolveModelResponse: structured path first, graceful fallback to the fenced-text parser ----------
  {
    const { call } = resolveModelResponse(JSON.stringify({ response_type: 'tool_call', tool: 'list_dir', args: {} }), true);
    ok(call?.tool === 'list_dir', 'resolveModelResponse(structuredOutputEnabled=true) parses a valid JSON envelope directly');
  }
  {
    const fenced = '```forge_action\n{"tool": "list_dir", "args": {}}\n```';
    const { call } = resolveModelResponse(fenced, true);
    ok(call?.tool === 'list_dir', 'when structured output is enabled but the model ignored the format and emitted the old fenced-block contract instead, resolveModelResponse still recovers the call via fallback');
  }
  {
    // A final_answer envelope has no "tool" key anywhere in it, so
    // parseToolCall's bare-JSON fallback can't accidentally "recover" a call
    // from it either way — this isolates exactly the behavior difference
    // enabling/disabling structured output should make.
    const envelope = JSON.stringify({ response_type: 'final_answer', final_answer: 'All done.' });
    const enabled = resolveModelResponse(envelope, true);
    ok(enabled.call === null && enabled.displayText === 'All done.', 'with structured output enabled, a final_answer envelope is unwrapped to its plain-text content');
    const disabled = resolveModelResponse(envelope, false);
    ok(disabled.call === null && disabled.displayText === envelope, 'with structured output disabled, the envelope-parsing path is skipped entirely — the raw JSON text is treated as the final answer verbatim, not unwrapped');
  }
}

// ============================================================================
// agent/planFirst.ts — separate planner/executor prompts
// ============================================================================
async function testPlanFirst() {
  {
    const calls: ChatMessage[][] = [];
    const fakeOllama: any = {
      chat: async (opts: any) => { calls.push(opts.messages); return '- Look at auth.ts\n- Add a null check\n- Re-run tests'; },
    };
    const plan = await generatePlanFirst({
      ollama: fakeOllama,
      model: 'fake-model',
      userMessage: 'fix the login bug',
      recentMessages: [],
      codebaseSearch: async () => [{ path: 'src/auth.ts:1-20', snippet: 'function login() {}', score: 0.9 }],
    });
    ok(!!plan && plan.includes('null check'), 'generatePlanFirst returns the model\'s plan text');
    const lastUserMsg = calls[0][calls[0].length - 1];
    ok(lastUserMsg.content.includes('src/auth.ts:1-20') && lastUserMsg.content.includes('function login()'), 'codebase-search hits are folded into the grounding block sent to the model');
    ok(calls[0][0].role === 'system' && !/forge_action/i.test(calls[0][0].content), 'the plan-first system message never mentions the fenced tool-call contract — it is a pure reasoning pass (it does explicitly tell the model not to use JSON, which is a separate, expected mention of the word)');
  }
  {
    const longText = 'x'.repeat(3000);
    const fakeOllama: any = { chat: async () => longText };
    const plan = await generatePlanFirst({ ollama: fakeOllama, model: 'm', userMessage: 'u', recentMessages: [] });
    ok(!!plan && plan.length <= 1502 && plan.endsWith('…'), `an overly long plan is truncated to MAX_PLAN_CHARS with an ellipsis (got length ${plan?.length})`);
  }
  {
    const fakeOllama: any = { chat: async () => { throw new Error('unreachable'); } };
    const plan = await generatePlanFirst({ ollama: fakeOllama, model: 'm', userMessage: 'u', recentMessages: [] });
    ok(plan === undefined, 'generatePlanFirst is best-effort — a model failure returns undefined rather than throwing');
  }
  {
    const fakeOllama: any = { chat: async () => '   ' };
    const plan = await generatePlanFirst({ ollama: fakeOllama, model: 'm', userMessage: 'u', recentMessages: [] });
    ok(plan === undefined, 'an empty/whitespace-only plan response returns undefined rather than an empty prefix block');
  }
  {
    const rendered = renderPlanFirstForPrompt('- step one\n- step two');
    ok(rendered.includes('## Your own plan for this turn') && rendered.includes('step one') && /adapt if you discover/i.test(rendered), 'renderPlanFirstForPrompt wraps the plan text with a header and a "this is a starting point" instruction');
  }
}

// ============================================================================
// agent/selfCritique.ts — verification-is-cheaper-than-generation critique pass
// ============================================================================
async function testSelfCritique() {
  ok(shouldCritique({ delete: true, content: 'x'.repeat(1000) }, 5) === false, 'a delete call never triggers self-critique regardless of content size');
  ok(shouldCritique({ content: 'one line' }, 40) === false, 'content shorter than minLines does not trigger self-critique');
  ok(shouldCritique({ content: Array.from({ length: 41 }, () => 'x').join('\n') }, 40) === true, 'content at/above minLines triggers self-critique');
  ok(shouldCritique({ replace: Array.from({ length: 41 }, () => 'x').join('\n') }, 40) === true, 'shouldCritique also looks at "replace" (targeted edits), not just "content"');
  ok(shouldCritique({}, 40) === false, 'a call with neither content nor replace never triggers self-critique');

  {
    const fakeOllama: any = { chat: async () => 'OK' };
    const critique = await critiqueEdit({ ollama: fakeOllama, model: 'm', path: 'x.ts', writtenText: 'code', isFullRewrite: true });
    ok(critique === undefined, 'a model reply of exactly "OK" means no concern -> undefined (folded into nothing)');
  }
  {
    const fakeOllama: any = { chat: async () => 'This duplicates the return statement above.' };
    const critique = await critiqueEdit({ ollama: fakeOllama, model: 'm', path: 'x.ts', writtenText: 'code', isFullRewrite: false });
    ok(critique === 'This duplicates the return statement above.', 'a genuine concern is returned verbatim (short, as instructed)');
  }
  {
    const fakeOllama: any = { chat: async () => 'x'.repeat(500) };
    const critique = await critiqueEdit({ ollama: fakeOllama, model: 'm', path: 'x.ts', writtenText: 'code', isFullRewrite: true });
    ok(!!critique && critique.length <= 401 && critique.endsWith('…'), `an overly long critique is truncated with an ellipsis (got length ${critique?.length})`);
  }
  {
    const fakeOllama: any = { chat: async () => { throw new Error('down'); } };
    const critique = await critiqueEdit({ ollama: fakeOllama, model: 'm', path: 'x.ts', writtenText: 'code', isFullRewrite: true });
    ok(critique === undefined, 'critiqueEdit is best-effort — a model failure returns undefined, never throws');
  }
}

// ============================================================================
// agent/bestOfN.ts — self-consistency / best-of-N for large full-file rewrites
// ============================================================================
async function testBestOfN() {
  const existingFileText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const goodRewrite = Array.from({ length: 50 }, (_, i) => `line ${i} updated`).join('\n');
  const forgeAction = (content: string, toolPath = 'src/big.ts') => `\`\`\`forge_action\n${JSON.stringify({ tool: 'write_file', args: { path: toolPath, content } })}\n\`\`\``;

  // ---------- a bad first candidate (truncated) is replaced by a better resampled one ----------
  {
    const truncated = 'line 0\nline 1'; // wildly shorter than the 50-line original -> rejected outright by the length-ratio guard
    let callCount = 0;
    const fakeOllama: any = {
      chat: async () => { callCount++; return forgeAction(goodRewrite); },
    };
    const best = await sampleBestOfNForRewrite({
      ollama: fakeOllama,
      promptView: [],
      model: 'm',
      temperature: 0.2,
      samples: 3,
      firstCandidate: { fullText: forgeAction(truncated), call: { tool: 'write_file', args: { path: 'src/big.ts', content: truncated }, raw: '' } },
      existingFileText,
      expectedPath: 'src/big.ts',
    });
    ok(callCount === 2, `sampleBestOfNForRewrite resamples exactly samples-1 more completions (requested 3, got ${callCount} extra calls)`);
    ok(best.call?.args.content === goodRewrite, 'a suspiciously truncated first candidate is swapped out for a properly-sized resampled candidate');
  }

  // ---------- every resample is worse than the first candidate -> first candidate wins, no forced swap ----------
  {
    const worse = 'x'; // rejected outright (too short + wrong shape)
    const fakeOllama: any = { chat: async () => forgeAction(worse) };
    const firstCandidate = { fullText: forgeAction(goodRewrite), call: { tool: 'write_file', args: { path: 'src/big.ts', content: goodRewrite }, raw: '' } as ToolCall };
    const best = await sampleBestOfNForRewrite({
      ollama: fakeOllama, promptView: [], model: 'm', temperature: 0.2, samples: 3,
      firstCandidate, existingFileText, expectedPath: 'src/big.ts',
    });
    ok(best.fullText === firstCandidate.fullText, 'when no resampled candidate scores better than the original, best-of-N falls back to the original unchanged');
  }

  // ---------- a candidate targeting the wrong path, or that isn't a write_file call at all, is rejected outright ----------
  {
    const wrongPath = forgeAction(goodRewrite, 'src/other.ts');
    const notWrite = '```forge_action\n{"tool": "read_file", "args": {"path": "src/big.ts"}}\n```';
    let n = 0;
    const fakeOllama: any = { chat: async () => { n++; return n === 1 ? wrongPath : notWrite; } };
    const firstCandidate = { fullText: forgeAction(goodRewrite), call: { tool: 'write_file', args: { path: 'src/big.ts', content: goodRewrite }, raw: '' } as ToolCall };
    const best = await sampleBestOfNForRewrite({
      ollama: fakeOllama, promptView: [], model: 'm', temperature: 0.2, samples: 3,
      firstCandidate, existingFileText, expectedPath: 'src/big.ts',
    });
    ok(best.fullText === firstCandidate.fullText, 'candidates targeting a different path or a different tool entirely are rejected (-Infinity), never selected over a valid original');
  }

  // ---------- a resample failure (model error mid-sampling) degrades gracefully, never throws ----------
  {
    let n = 0;
    const fakeOllama: any = { chat: async () => { n++; if (n === 1) throw new Error('timeout'); return forgeAction(goodRewrite); } };
    const firstCandidate = { fullText: forgeAction('short'), call: { tool: 'write_file', args: { path: 'src/big.ts', content: 'short' }, raw: '' } as ToolCall };
    const best = await sampleBestOfNForRewrite({
      ollama: fakeOllama, promptView: [], model: 'm', temperature: 0.2, samples: 3,
      firstCandidate, existingFileText, expectedPath: 'src/big.ts',
    });
    ok(best.call?.args.content === goodRewrite, 'one resample throwing does not abort the whole best-of-N pass — the surviving successful resample can still win');
  }

  ok(MIN_LINES_FOR_BEST_OF_N === 40, 'MIN_LINES_FOR_BEST_OF_N constant is exported and matches the documented threshold');
}

// ============================================================================
// agent/systemPrompt.ts — prompt-prefix stability (KV-cache reuse) fix
// ============================================================================
function testPromptPrefixStability() {
  // The core guarantee: buildSystemPrompt()'s output must be byte-identical
  // across turns even as memory/milestones/project-log content grows, since
  // that's exactly what busts a local server's prompt-prefix KV cache.
  const p1 = buildSystemPrompt('demo', 'agent', { rulesText: 'r' });
  const p2 = buildSystemPrompt('demo', 'agent', { rulesText: 'r' });
  ok(p1 === p2, 'buildSystemPrompt() with the same (turn-stable) inputs produces byte-identical output turn over turn');
  ok(!p1.includes('## Project log') && !p1.includes('## Memory') && !/milestone/i.test(p1), 'buildSystemPrompt() output contains no trace of memory/milestone/project-log content — that all lives in buildTurnContextPrefix() now');

  // buildTurnContextPrefix, by contrast, is EXPECTED to change every turn — that's fine because it's the tail of the ALREADY-new per-turn user message, not the cached system message.
  const prefixTurn1 = buildTurnContextPrefix({ milestonesText: '## Milestones\n- did thing 1' });
  const prefixTurn5 = buildTurnContextPrefix({ milestonesText: '## Milestones\n- did thing 1\n- did thing 2\n- did thing 3\n- did thing 4\n- did thing 5' });
  ok(prefixTurn1 !== prefixTurn5, 'buildTurnContextPrefix legitimately grows turn over turn as milestones accumulate');
  ok(buildTurnContextPrefix({}) === '', 'buildTurnContextPrefix returns an empty string (not e.g. "undefined" or stray whitespace) when nothing is supplied');

  // MCP tools appear in the tool docs for agent/auto/outcome modes, but never leak into ask/plan mode's prompt.
  const mcpTools = [{ name: 'mcp_github_search_issues', describe: '[MCP: github] Searches issues.', exampleArgs: { query: 'bug' } }];
  const agentPrompt = buildSystemPrompt('demo', 'agent', { mcpTools });
  const askPrompt = buildSystemPrompt('demo', 'ask', { mcpTools });
  const planPrompt = buildSystemPrompt('demo', 'plan', { mcpTools });
  ok(agentPrompt.includes('mcp_github_search_issues'), 'an MCP tool is listed in Agent mode\'s tool docs');
  ok(!askPrompt.includes('mcp_github_search_issues'), 'an MCP tool is hidden from Ask mode\'s tool docs (read-only mode)');
  ok(!planPrompt.includes('mcp_github_search_issues'), 'an MCP tool is hidden from Plan mode\'s tool docs (no tools at all in Plan mode)');

  // Structured-output mode swaps the action contract wording, never applies to Plan mode.
  const structuredPrompt = buildSystemPrompt('demo', 'agent', { structuredOutput: true });
  ok(/response_type/.test(structuredPrompt) && !/```forge_action/.test(structuredPrompt), 'structuredOutput:true swaps the fenced-text contract for the JSON-envelope instructions');
  const structuredPlanPrompt = buildSystemPrompt('demo', 'plan', { structuredOutput: true });
  ok(!/response_type/.test(structuredPlanPrompt), 'structuredOutput has no effect on Plan mode\'s prompt — Plan mode always replies in plain text');
}

// ============================================================================
// util/config.ts — new v0.11.0 settings wired with correct keys and defaults
// ============================================================================
function testConfigDefaults() {
  vs.__resetConfig();
  const defaults = getConfig();
  ok(defaults.structuredOutputEnabled === false, 'forge.structuredOutput.enabled defaults to false');
  ok(defaults.planFirstEnabled === false, 'forge.planFirst.enabled defaults to false');
  ok(defaults.selfCritiqueEnabled === false, 'forge.selfCritique.enabled defaults to false');
  ok(defaults.selfCritiqueMinLines === 40, 'forge.selfCritique.minLines defaults to 40');
  ok(defaults.bestOfNEnabled === false, 'forge.bestOfN.enabled defaults to false');
  ok(defaults.bestOfNSamples === 3, 'forge.bestOfN.samples defaults to 3');
  ok(Array.isArray(defaults.mcpServers) && defaults.mcpServers.length === 0, 'forge.mcp.servers defaults to an empty array');

  vs.__setConfig({
    'forge.structuredOutput.enabled': true,
    'forge.planFirst.enabled': true,
    'forge.selfCritique.enabled': true,
    'forge.selfCritique.minLines': 15,
    'forge.bestOfN.enabled': true,
    'forge.bestOfN.samples': 5,
    'forge.mcp.servers': [{ name: 'x', command: 'node' }],
  });
  const overridden = getConfig();
  ok(overridden.structuredOutputEnabled === true && overridden.planFirstEnabled === true && overridden.selfCritiqueEnabled === true, 'all three boolean toggles read back true once set under their exact dotted keys');
  ok(overridden.selfCritiqueMinLines === 15 && overridden.bestOfNSamples === 5, 'numeric settings read back their overridden values');
  ok(overridden.mcpServers.length === 1 && overridden.mcpServers[0].name === 'x', 'forge.mcp.servers reads back the configured server list');
  vs.__resetConfig();
}

// ============================================================================
// mcp/mcpClient.ts + mcp/mcpManager.ts — native MCP integration, against a REAL spawned server process
// ============================================================================
async function testMcpIntegration() {
  // ---------- McpClient direct: real handshake, tools/list, tools/call (success + tool-level error), dispose ----------
  {
    const client = new McpClient({ name: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER] });
    await client.connect();
    const tools = await client.listTools();
    ok(tools.length === 2 && tools.some((t) => t.name === 'echo') && tools.some((t) => t.name === 'fail'), `listTools() returns both tools from the real spawned server (got ${tools.map((t) => t.name).join(',')})`);

    const echoResult = await client.callTool('echo', { text: 'hello' });
    ok(echoResult.ok === true && echoResult.content === 'echo: hello', `callTool("echo") round-trips through the real child process (got ${JSON.stringify(echoResult)})`);

    const failResult = await client.callTool('fail', {});
    ok(failResult.ok === false && /always fails/.test(failResult.content), 'a tool-level error (isError:true from the server) surfaces as {ok:false}, not a thrown exception');

    client.dispose();
    let threwAfterDispose = false;
    try {
      await client.callTool('echo', { text: 'after dispose' });
    } catch {
      threwAfterDispose = true;
    }
    ok(threwAfterDispose, 'calling a disposed client rejects rather than hanging or silently succeeding');
  }

  // ---------- graceful version-mismatch handling: a server negotiating a different protocol version does not fail connect() ----------
  {
    const client = new McpClient({ name: 'old-version', command: process.execPath, args: [FAKE_MCP_SERVER], env: { FAKE_MCP_PROTOCOL_VERSION: '2024-11-05' } });
    let threw = false;
    try {
      await client.connect();
    } catch {
      threw = true;
    }
    ok(!threw, 'a server negotiating an older protocol version than Forge asked for does not fail the handshake (logged, not fatal)');
    client.dispose();
  }

  // ---------- a bad command fails connect() with a clear error, without crashing the process ----------
  {
    const client = new McpClient({ name: 'bad', command: '/no/such/binary/forge-test-xyz' });
    let message = '';
    try {
      await client.connect();
    } catch (err: any) {
      message = err.message;
    }
    ok(/bad/.test(message), 'a server that fails to spawn throws a clear, server-named error rather than hanging');
  }

  // ---------- McpManager: starts every configured server, namespaces tool names, reports status ----------
  {
    const manager = new McpManager(() => [{ name: 'My Server!', command: process.execPath, args: [FAKE_MCP_SERVER] }]);
    await manager.start();
    const specs = manager.listToolSpecs();
    ok(specs.some((s) => s.name === 'mcp__My_Server__echo'), `tool names are namespaced as mcp__<sanitized-server>__<tool> — double underscore, 0.14.0's Claude-Code-matching convention (got ${specs.map((s) => s.name).join(',')})`);
    const status = manager.status();
    ok(status.length === 1 && status[0].connected === true && status[0].toolCount === 2, `status() reports the server connected with its 2 tools (got ${JSON.stringify(status)})`);

    // ---- calling a tool through its DynamicToolSpec goes through the approval gate ----
    const echoSpec = specs.find((s) => s.name === 'mcp__My_Server__echo')!;
    const approvedCtx: any = { requestCommandApproval: async () => true };
    const approvedResult = await echoSpec.run({ text: 'via manager' }, approvedCtx);
    ok(approvedResult.ok === true && approvedResult.content === 'echo: via manager', 'an approved MCP tool call executes and returns the remote server\'s result');

    const deniedCtx: any = { requestCommandApproval: async () => false };
    const deniedResult = await echoSpec.run({ text: 'nope' }, deniedCtx);
    ok(deniedResult.ok === false && /did not approve/i.test(deniedResult.content), 'a denied approval short-circuits before calling the remote server, and reports why');

    manager.disposeAll();
    ok(manager.listToolSpecs().length === 0, 'disposeAll() clears every tool spec');
    ok(manager.status()[0].connected === false, 'status() reflects disconnection after disposeAll()');
  }

  // ---------- one bad server config never prevents the others from starting ----------
  {
    const manager = new McpManager(() => [
      { name: '', command: '' }, // missing name/command -> skipped with a startError
      { name: 'good', command: process.execPath, args: [FAKE_MCP_SERVER] },
    ]);
    await manager.start();
    ok(manager.listToolSpecs().some((s) => s.name.startsWith('mcp__good__')), 'the well-formed server still starts and contributes tools even though a sibling entry was malformed');
    ok(manager.lastStartErrors().length >= 1, 'the malformed entry is recorded in lastStartErrors() rather than silently dropped or crashing the whole manager');
    manager.disposeAll();
  }

  // ---------- full agentLoop.ts integration: the model calls a real MCP tool through runAgentTurn end-to-end ----------
  {
    const manager = new McpManager(() => [{ name: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER] }]);
    await manager.start();
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) return '```forge_action\n{"tool": "mcp__fake__echo", "args": {"text": "from the agent"}}\n```';
        return 'All done — the MCP tool echoed back successfully.';
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
    await runAgentTurn([], 'echo something via mcp', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });
    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    ok(!!toolResult && toolResult.ok === true && /echo: from the agent/.test(toolResult.summary), `runAgentTurn actually invoked the real MCP server end-to-end and got its echo back (got ${JSON.stringify(toolResult)})`);
    const final = events.find((e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final');
    ok(!!final, 'the turn reached a final answer after the MCP tool call');
    manager.disposeAll();
  }

  // ---------- mode gating: an MCP tool is refused in Ask mode, same as write_file/run_command would be ----------
  {
    const manager = new McpManager(() => [{ name: 'fake', command: process.execPath, args: [FAKE_MCP_SERVER] }]);
    await manager.start();
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) return '```forge_action\n{"tool": "mcp__fake__echo", "args": {"text": "x"}}\n```';
        return 'Cannot do that in Ask mode.';
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
    await runAgentTurn([], 'echo something', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'ask' });
    const toolResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
    ok(!!toolResult && toolResult.ok === false && /not available in ask mode/i.test(toolResult.summary), `an MCP tool call is refused in Ask mode with the same style of message built-in tools use (got ${JSON.stringify(toolResult)})`);
    manager.disposeAll();
  }
}

// ============================================================================
// main
// ============================================================================
async function main() {
  testChunkerStructural();
  testImportGraph();
  await testWorkspaceIndexWeighting();
  await testFuzzyMatchingAndBalanceRegression();
  testStructuredOutput();
  await testPlanFirst();
  await testSelfCritique();
  await testBestOfN();
  testPromptPrefixStability();
  testConfigDefaults();
  await testMcpIntegration();

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('Some v0.11.0 runtime tests FAILED.');
    process.exit(1);
  }
  console.log('All v0.11.0 runtime tests passed.');
}

main().catch((err) => {
  console.error('Uncaught error in test_v11.ts:', err);
  process.exit(1);
});
