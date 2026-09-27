import { diffLines, unifiedDiff } from '../../src/util/diff';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseToolCall,
  stripActionBlock,
  looksLikeAbandonedToolCall,
  extractAbandonedActionTarget,
  formatIncompleteActionNudge,
  preprocessHarmonyReply,
  stripHarmonyControlTokens,
  detectForeignToolCall,
  formatForeignToolCallNudge,
  assistantContentForHistory,
  tryAcceptNativeToolCall,
  formatToolCallForHistory,
} from '../../src/agent/toolProtocol';
import { resolveModelResponse } from '../../src/agent/agentLoop';
import { formatUnresolvedFailureNudge } from '../../src/agent/claimChecker';
import { cleanCompletion } from '../../src/completion/fimPrompt';
import { requireStringArg, suggestCommandFromArgvArray } from '../../src/tools/argErrors';

let passed = 0;
let failed = 0;
function assert(cond: any, msg: string) {
  if (cond) {
    passed++;
    console.log('ok -', msg);
  } else {
    failed++;
    console.log('NOT OK -', msg);
  }
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
  assert(r === null, 'bare tool/args JSON outside a fence is not executed (foreign-format nudge instead)');
  const foreign = detectForeignToolCall('I will run: {"tool": "search_code", "args": {"query": "foo"}} now.');
  assert(foreign && foreign.tool === 'search_code' && foreign.args?.query === 'foo', 'detectForeignToolCall finds bare tool/args JSON');
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
  const twoTools =
    'Thinking: {"tool":"read_file","args":{"path":"old.py"}} — now the real call {"tool":"write_file","args":{"path":"new.py","content":"partial';
  const t = extractAbandonedActionTarget(twoTools);
  assert(t && t.tool === 'write_file' && t.path === 'new.py', 'extractAbandonedActionTarget uses the last "tool" fragment when several appear');
}
{
  const pathBeforeLast =
    '{"tool":"write_file","args":{"path":"ignored.py"}} padding {"tool":"write_file","args":{"path":"keep.py","content":"x';
  const t = extractAbandonedActionTarget(pathBeforeLast);
  assert(t && t.path === 'keep.py', 'extractAbandonedActionTarget ignores a path that appears before the last tool match');
}
{
  const generic = formatIncompleteActionNudge('still thinking about the module…', true);
  assert(/cut off by the output-length limit/.test(generic) && /your next action/.test(generic), 'formatIncompleteActionNudge keeps generic length wording when nothing is extractable');
  const genericAbandoned = formatIncompleteActionNudge('```forge_action\n{"tool":"write', false);
  assert(/JSON was left incomplete/.test(genericAbandoned) && /your next action/.test(genericAbandoned), 'formatIncompleteActionNudge keeps generic abandoned wording when tool name is not fully quoted');
  const toolOnlyNudge = formatIncompleteActionNudge('{"tool":"write_file","args":{"path":"contacts/storage.py', false);
  assert(/middle of write_file/.test(toolOnlyNudge) && /Finish that exact write_file action/.test(toolOnlyNudge), 'formatIncompleteActionNudge names the tool when path is not extractable');
  const specificPath = formatIncompleteActionNudge(
    '{"tool":"write_file","args":{"path":"contacts/storage.py","content":"x',
    false
  );
  assert(/Do not repeat your analysis; keep any reasoning to a couple of sentences/.test(specificPath), 'formatIncompleteActionNudge appends the short reasoning hint on specific path nudges');
}

// ---- Harmony channels + foreign tool-call formats (gpt-oss smoke finding) ----
{
  const smoke =
    '<|channel|>analysis<|message|>We need to run tests. Let\'s run tests.<|end|><|start|>assistant<|channel|>commentary to=run_command <|constrain|>json<|message|>{"command":"python3 -m unittest discover -s tests -t ."}';
  const pre = preprocessHarmonyReply(smoke);
  assert(pre.reasoning.includes('run tests') && !pre.displayText.includes('analysis'), 'analysis channel becomes reasoning, not display text');
  assert(parseToolCall(smoke) === null, 'Harmony commentary tool call is not a forge_action');
  const foreign = detectForeignToolCall(smoke);
  assert(foreign && foreign.tool === 'run_command' && foreign.args?.command === 'python3 -m unittest discover -s tests -t .', 'detectForeignToolCall extracts Harmony to=run_command args');
  const known = ['run_command', 'read_file'];
  const nudge = formatForeignToolCallNudge(foreign!, known);
  assert(/Not executed: you called run_command using a native tool-call format/.test(nudge), 'foreign nudge names run_command');
  assert(/"command":"python3 -m unittest discover -s tests -t ."/.test(nudge), 'foreign nudge includes extracted command args in forge_action resend');
  const resolved = resolveModelResponse(smoke, false);
  assert(resolved.call === null && !resolved.displayText.includes('<|channel|>'), 'Harmony smoke reply is not a final answer with raw control tokens');
}
{
  const xml = 'Here <tool_call>{"name":"list_dir","arguments":{"path":"src"}}</tool_call>';
  const foreign = detectForeignToolCall(xml);
  assert(foreign && foreign.tool === 'list_dir' && foreign.args?.path === 'src', 'detectForeignToolCall parses <tool_call> name/arguments');
}
{
  const unknown = '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>';
  const nudge = formatForeignToolCallNudge(detectForeignToolCall(unknown)!, ['read_file', 'run_command']);
  assert(/which is not a Forge tool/.test(nudge) && /read_file/.test(nudge) && /run_command/.test(nudge), 'unknown foreign tool lists available Forge tools');
}
{
  const harmonyFinal =
    '<|channel|>analysis<|message|>secret thoughts<|end|><|start|>assistant<|channel|>final<|message|>The answer is 42<|end|>';
  const pre = preprocessHarmonyReply(harmonyFinal);
  assert(pre.reasoning === 'secret thoughts' && pre.displayText === 'The answer is 42', 'final channel is display text without analysis');
  assert(stripHarmonyControlTokens(pre.displayText) === 'The answer is 42', 'stripHarmonyControlTokens leaves clean answer text');
  assert(detectForeignToolCall(harmonyFinal) === null, 'analysis + final prose is not a foreign tool call');
}
{
  const fenced = '```forge_action\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```';
  assert(parseToolCall(fenced)?.tool === 'read_file', 'normal forge_action still parses');
  assert(detectForeignToolCall(fenced) === null, 'valid forge_action is not flagged as foreign');
}
{
  const smoke =
    '<|channel|>analysis<|message|>We need to run tests. Let\'s run tests.<|end|><|start|>assistant<|channel|>commentary to=run_command <|constrain|>json<|message|>{"command":"python3 -m unittest discover -s tests -t ."}';
  const stored = assistantContentForHistory(smoke);
  assert(!/<\|[^|]+\|>/.test(stored), 'history never stores Harmony control tokens');
  assert(stored.includes('run_command') && stored.includes('native format'), 'foreign Harmony call becomes a short plain history line');
  assert(!stored.includes('We need to run tests'), 'analysis channel is not stored in history');
  const finalOnly =
    '<|channel|>analysis<|message|>hidden<|end|><|start|>assistant<|channel|>final<|message|>Done.<|end|>';
  assert(assistantContentForHistory(finalOnly) === 'Done.', 'final channel text is stored without controls or analysis');
  const plain = '```forge_action\n{"tool": "read_file", "args": {"path": "a.ts"}}\n```';
  assert(assistantContentForHistory(plain) === plain, 'plain forge_action is stored verbatim');
}

// ---- native tool-call acceptance (gpt-oss smoke3) ----
{
  const known = ['run_command', 'read_file'];
  const smoke1 =
    '<|channel|>analysis<|message|>We need to run tests. Let\'s run tests.<|end|><|start|>assistant<|channel|>commentary to=run_command <|constrain|>json<|message|>{"command":"python3 -m unittest discover -s tests -t ."}';
  const foreign1 = detectForeignToolCall(smoke1)!;
  const acc1 = tryAcceptNativeToolCall(foreign1, known);
  assert(acc1?.call.tool === 'run_command' && acc1.format === 'harmony-commentary', 'smoke3 msg1 Harmony run_command is accepted');
  const hist1 = formatToolCallForHistory(acc1!.call);
  assert(hist1.startsWith('```forge_action') && hist1.includes('run_command') && !hist1.includes('<|'), 'accepted native call stores clean forge_action history');

  const smoke4 =
    'assistantcommentary to=forge_action json{"tool":"run_command","args":{"command":"python3 -m unittest discover -s tests -t ."}}';
  const foreign4 = detectForeignToolCall(smoke4)!;
  const acc4 = tryAcceptNativeToolCall(foreign4, known);
  assert(acc4?.call.tool === 'run_command', 'smoke3 msg4 garbled bare JSON run_command is accepted');

  const wrapped =
    '<|channel|>commentary to=forge_action <|constrain|>json<|message|>{"tool":"run_command","args":{"command":"echo hi"}}';
  const accWrap = tryAcceptNativeToolCall(detectForeignToolCall(wrapped)!, known);
  assert(accWrap?.call.tool === 'run_command' && accWrap.call.args.command === 'echo hi', 'harmony to=forge_action with inner tool/args is accepted');

  const badWrap =
    '<|channel|>commentary to=forge_action <|constrain|>json<|message|>{"tool":"run_command","args":';
  assert(tryAcceptNativeToolCall(detectForeignToolCall(badWrap)!, known) === null, 'forge_action wrapper with invalid JSON is not accepted');

  const unknownNative = '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>';
  const nudge = formatForeignToolCallNudge(detectForeignToolCall(unknownNative)!, known);
  assert(/which is not a Forge tool/.test(nudge) && /run_command/.test(nudge), 'unknown native tool nudge lists Forge tools');

  const emptyWrap =
    '<|channel|>commentary to=forge_action <|constrain|>json<|message|>{}';
  const foreignEmpty = detectForeignToolCall(emptyWrap)!;
  const nudgeEmpty = formatForeignToolCallNudge(foreignEmpty, known, emptyWrap);
  assert(foreignEmpty.tool === 'forge_action' && foreignEmpty.args !== null && Object.keys(foreignEmpty.args).length === 0, 'harmony forge_action with {} is detected');
  assert(/empty JSON \{\}/.test(nudgeEmpty) && !/which is not a Forge tool/.test(nudgeEmpty), 'empty forge_action wrapper nudge names missing payload, not unknown tool');

  const missingArgsWrap =
    '<|channel|>commentary to=forge_action <|constrain|>json<|message|>{"tool":"run_command"}';
  const nudgeMissingArgs = formatForeignToolCallNudge(detectForeignToolCall(missingArgsWrap)!, known, missingArgsWrap);
  assert(/no "args" object/.test(nudgeMissingArgs), 'forge_action wrapper without args object gets specific nudge');

  const nudgeBadWrap = formatForeignToolCallNudge(detectForeignToolCall(badWrap)!, known, badWrap);
  assert(/not valid JSON/.test(nudgeBadWrap) && /near:/.test(nudgeBadWrap) && !/which is not a Forge tool/.test(nudgeBadWrap), 'unparseable forge_action wrapper gets JSON parse error nudge');
}
{
  const t09Stripped =
    'assistantanalysis to=repo_browser.open_file code{"path":"inventory/cli.py","line_start":1,"line_end":40}';
  const foreign = detectForeignToolCall(t09Stripped);
  assert(
    foreign && foreign.tool === 'repo_browser.open_file' && foreign.args?.path === 'inventory/cli.py',
    'detectForeignToolCall finds analysis-channel Harmony with code constrain on stripped text',
  );
  const known = ['read_file', 'write_file', 'run_command'];
  const nudge = formatForeignToolCallNudge(foreign!, known);
  assert(/repo_browser\.open_file/.test(nudge) && /read_file/.test(nudge) && /write_file/.test(nudge), 'unknown foreign tool with path hints read_file/write_file');
  const analysisChannel =
    '<|channel|>analysis to=repo_browser.open_file <|constrain|>code<|message|>{"path":"inventory/cli.py","line_start":1,"line_end":40}<|end|>';
  const foreignRaw = detectForeignToolCall(analysisChannel);
  assert(foreignRaw?.tool === 'repo_browser.open_file', 'Harmony foreign call on analysis channel is detected in raw text');
}

// ---- arg type errors + unresolved failure nudge ----
{
  const arr = ['bash', '-lc', "python3 -m py_compile $(git ls-files '*.py')"];
  assert(
    suggestCommandFromArgvArray(arr) === "python3 -m py_compile $(git ls-files '*.py')",
    'suggestCommandFromArgvArray uses -lc payload',
  );
  const wrong = requireStringArg('run_command', 'command', arr, 'Missing required arg "command".', (w) =>
    Array.isArray(w) ? suggestCommandFromArgvArray(w) : undefined,
  );
  assert(!wrong.ok && /must be a string, but you sent an array/.test(wrong.content), 'wrong-type command mentions array');
  assert(/python3 -m py_compile/.test(wrong.content), 'wrong-type command suggests resend with shell string');
}
{
  const nudge = formatUnresolvedFailureNudge({
    command: 'python3 main.py demo',
    exitCode: 2,
    filesEditedAfter: ['inventory/cli.py'],
  });
  assert(
    /Your last command `python3 main.py demo` failed \(exit 2\)/.test(nudge) &&
      /you then edited: inventory\/cli\.py/.test(nudge),
    'unresolved failure nudge names command, exit, and post-failure edits',
  );
}

// ---- parseToolCall: invalid JSON in closed fence (t08 cycle 1, no brace auto-repair) ----
{
  const t08Messages = path.join(__dirname, '../e2e/results/t08-five-file-build-mlx4bit-cycle1.messages.json');
  const raw = fs.readFileSync(t08Messages, 'utf8');
  const msgs = JSON.parse(raw) as { content: string }[];
  const body = msgs[4].content.match(/```forge_action\s*\n([\s\S]*?)```/)![1].trim();
  const wrapped = '```forge_action\n' + body + '\n```';
  assert(parseToolCall(wrapped) === null, 't08 message-4 body (missing one closing brace) does not parse as a tool call');
  const t08Nudge = formatIncompleteActionNudge(wrapped, false);
  assert(/not valid JSON/.test(t08Nudge) && /write_file/.test(t08Nudge) && /tracker\/models\.py/.test(t08Nudge) && /near:/.test(t08Nudge) && !/reply was cut off/.test(t08Nudge), 't08 missing-brace body gets invalid-JSON nudge naming write_file on tracker/models.py');
  const broken = '{"tool":"write_file","args":{"path":"a.py","content":"line with \\"broken';
  assert(parseToolCall(broken) === null, 'a genuinely broken string is not parsed as a tool call');
}
{
  const invalidClosed =
    '```forge_action\n{"tool":"write_file","args":{"path":"tracker/models.py","content":"still open\n```';
  const nudge = formatIncompleteActionNudge(invalidClosed, false);
  assert(/not valid JSON/.test(nudge) && /tracker\/models\.py/.test(nudge) && /near:/.test(nudge) && !/reply was cut off/.test(nudge), 'closed-fence invalid JSON nudge names the parse error, not a false cut-off');
  const lengthNudge = formatIncompleteActionNudge(invalidClosed, true);
  assert(/cut off/.test(lengthNudge), 'length-truncated still uses cut-off wording even when the fence is closed');
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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
console.log('All runtime tests passed.');
