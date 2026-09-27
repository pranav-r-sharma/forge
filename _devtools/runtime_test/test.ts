import { diffLines, unifiedDiff } from '../../src/util/diff';
import { parseToolCall, stripActionBlock, looksLikeAbandonedToolCall, extractAbandonedActionTarget, formatIncompleteActionNudge } from '../../src/agent/toolProtocol';
import { cleanCompletion } from '../../src/completion/fimPrompt';

function assert(cond: any, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
}

// ---- diffLines / unifiedDiff ----
{
  const a = 'a\nb\nc\nd\ne';
  const b = 'a\nx\nc\nd\ny';
  const ops = diffLines(a, b);
  const reconstructedOld = ops.filter(o => o.type !== 'add').map(o => o.line).join('\n');
  const reconstructedNew = ops.filter(o => o.type !== 'del').map(o => o.line).join('\n');
  assert(reconstructedOld === a, 'diffLines reconstructs original from equal+del');
  assert(reconstructedNew === b, 'diffLines reconstructs new from equal+add');

  const { text, additions, deletions } = unifiedDiff(a, b);
  assert(additions === 2 && deletions === 2, `unifiedDiff counts (+${additions}/-${deletions}) match expected 2/2`);
  assert(text.includes('-b') && text.includes('+x'), 'unifiedDiff text contains expected -/+ lines');
}

{
  // identical text -> no ops
  const ops = diffLines('same\ntext', 'same\ntext');
  assert(ops.every(o => o.type === 'equal'), 'identical text yields only equal ops');
}

{
  // empty old (pure create)
  const ops = diffLines('', 'new content\nline2');
  assert(ops.every(o => o.type === 'add'), 'empty original yields only additions');
}

{
  // empty new (pure delete)
  const ops = diffLines('gone\nlines', '');
  assert(ops.every(o => o.type === 'del'), 'empty new yields only deletions');
}

// ---- parseToolCall ----
{
  const r = parseToolCall('```forge_action\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```');
  assert(r && r.tool === 'read_file' && r.args.path === 'a.ts', 'parses well-formed forge_action block');
}
{
  const r = parseToolCall('Sure, here is the answer: the sky is blue.');
  assert(r === null, 'plain prose returns null (final answer)');
}
{
  const r = parseToolCall('Let me check that.\n```json\n{"tool":"list_dir","args":{"path":"."}}\n```\nSome trailing notes.');
  assert(r && r.tool === 'list_dir', 'parses ```json fence fallback with surrounding prose');
}
{
  const r = parseToolCall('I will run: {"tool": "search_code", "args": {"query": "foo"}} now.');
  assert(r && r.tool === 'search_code', 'parses bare JSON object fallback (no fence)');
}
{
  const r = parseToolCall('```forge_action\n{"tool": "write_file", "args": {"path": "x.ts", "content": "line1\\nline2"}}\n```');
  assert(r && r.args.content === 'line1\nline2', 'JSON string escapes (\\n) decode correctly inside args');
}
{
  const stripped = stripActionBlock('intro text\n```forge_action\n{"tool":"read_file","args":{}}\n```');
  assert(stripped === 'intro text', 'stripActionBlock removes the fenced block');
}

// ---- looksLikeAbandonedToolCall (t07-build-from-scratch acceptance-test finding: a stop token mid-JSON on a
// large write_file leaves an unparseable forge_action block that must NOT be treated as a final answer) ----
{
  // Reproduces the actual failure: the model finishes a long write_file's content and stops (finishReason
  // "stop", not "length") right after typing a closing ``` out of habit, never closing the JSON itself.
  const truncated = '```forge_action\n{"tool":"write_file","args":{"path":"contacts/storage.py","content":"import json\\nclass ContactBook:\\n    def add(self';
  assert(parseToolCall(truncated) === null, 'a forge_action JSON left open mid-string does not parse as a call');
  assert(looksLikeAbandonedToolCall(truncated), 'but it IS recognized as an abandoned action attempt, not a clean final answer');
}
{
  const prose = 'Done - I added the delete command and ran the tests, all green.';
  assert(parseToolCall(prose) === null && !looksLikeAbandonedToolCall(prose), 'a genuine final answer with no tool mention is not flagged as an abandoned action');
}
{
  const exampleJson = 'Here is the shape of one record:\n```json\n{"id": 1, "name": "Alice"}\n```';
  assert(parseToolCall(exampleJson) === null && !looksLikeAbandonedToolCall(exampleJson), 'a valid JSON example with no "tool" key is not flagged as an abandoned action');
}

// ---- extractAbandonedActionTarget / formatIncompleteActionNudge (strict-catch nudge specificity) ----
{
  const truncated = '```forge_action\n{"tool":"write_file","args":{"path":"contacts/storage.py","content":"import json\\nclass ContactBook:\\n    def add(self';
  const t = extractAbandonedActionTarget(truncated);
  assert(t && t.tool === 'write_file' && t.path === 'contacts/storage.py', 'extractAbandonedActionTarget gets tool+path from an abandoned write_file fragment');
}
{
  const toolOnly = '{"tool": "search_code", "args": {"query": "foo';
  const t = extractAbandonedActionTarget(toolOnly);
  assert(t && t.tool === 'search_code' && t.path === undefined, 'extractAbandonedActionTarget gets tool only when path string is not closed');
}
{
  assert(extractAbandonedActionTarget('plain prose with no tool key') === undefined, 'extractAbandonedActionTarget returns undefined when no tool name is extractable');
}
{
  const generic = formatIncompleteActionNudge('still thinking about the module…', true);
  assert(/cut off by the output-length limit/.test(generic) && /your next action/.test(generic), 'formatIncompleteActionNudge keeps generic length wording when nothing is extractable');
  const genericAbandoned = formatIncompleteActionNudge('```forge_action\n{"tool":"write', false);
  assert(/JSON was left incomplete/.test(genericAbandoned) && /your next action/.test(genericAbandoned), 'formatIncompleteActionNudge keeps generic abandoned wording when tool name is not fully quoted');
  const toolOnlyNudge = formatIncompleteActionNudge('{"tool":"write_file","args":{"path":"contacts/storage.py', false);
  assert(/middle of write_file/.test(toolOnlyNudge) && /Finish that exact write_file action/.test(toolOnlyNudge), 'formatIncompleteActionNudge names the tool when path is not extractable');
}

// ---- cleanCompletion ----
{
  const c = cleanCompletion('```ts\nconst x = 1;\n```', '');
  assert(c.trim() === 'const x = 1;', 'cleanCompletion strips markdown fence');
}
{
  const c = cleanCompletion('return a + b;\n}\nfunction next() {', 'function next() {\n  return 0;\n}');
  assert(!c.includes('function next() {\n  return 0'), 'cleanCompletion trims when model re-types the suffix');
}

console.log('\nAll runtime tests passed.');
