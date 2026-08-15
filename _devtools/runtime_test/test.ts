import { diffLines, unifiedDiff } from '../../src/util/diff';
import { parseToolCall, stripActionBlock } from '../../src/agent/toolProtocol';
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
