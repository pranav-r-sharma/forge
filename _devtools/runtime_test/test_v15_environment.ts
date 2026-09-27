// ============================================================================
// 0.15.0: environment facts for the system prompt (src/agent/environment.ts). Found by the first end-to-end run: the model guessed `python` on a
// machine with only `python3` and ran tests from the wrong directory (4 wasted steps). Detection is deterministic, presence-only, never throws.
// ============================================================================
import * as path from 'path';
import { findOnPath, detectEnvironment, renderEnvironment } from '../../src/agent/environment';
import { buildSystemPrompt } from '../../src/agent/systemPrompt';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

const fsOf = (files: Record<string, string | string[]>) => ({
  readdir: (p: string) => { const v = files[p]; return Array.isArray(v) ? v : []; },
  readFile: (p: string) => { const v = files[p]; return typeof v === 'string' ? v : undefined; },
  exists: (p: string) => p in files,
});
const on = (...cmds: string[]) => (p: string) => cmds.some((c) => p.endsWith(path.sep + c));
const base = { platform: 'darwin', arch: 'arm64', shell: '/bin/zsh', pathEnv: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) };

function testPathScan() {
  ok(findOnPath('git', '/a:/b', (p) => p === '/b/git'), 'finds a tool in any PATH directory');
  ok(!findOnPath('git', '/a:/b', () => false) && !findOnPath('git', '', () => true), 'not found / empty PATH → false');
  ok(!findOnPath('git', ':/a::', (p) => p === '/git'), 'empty PATH entries are ignored (they must not resolve to the root)');
}

function testPythonProject() {
  const f = detectEnvironment('/ws', 'shop', { ...base, isExec: on('python3', 'git'), ...fsOf({ '/ws': ['shop', 'tests', '.git'], '/ws/tests': ['test_cart.py', '__init__.py'], '/ws/.git': [] }) });
  ok(f.projectKinds.includes('Python') && f.available.includes('python3') && f.missing.includes('python'), 'Python project on a machine with python3 but no python');
  ok(f.testCommand === 'python3 -m unittest discover -s tests -t .', `unittest-style tests → the right command from the workspace root (got ${f.testCommand})`);
  const text = renderEnvironment(f);
  ok(/`python` is NOT installed — use `python3`/.test(text) && /Likely test command/.test(text) && /macOS \(arm64\)/.test(text) && /shell: zsh/.test(text), 'the rendered section says so plainly');
  ok(/pytest` is not installed/.test(text), 'and warns that pytest is missing');
  const pt = detectEnvironment('/ws', 'x', { ...base, isExec: on('python3', 'pytest'), ...fsOf({ '/ws': ['pytest.ini', 'tests'], '/ws/tests': ['test_a.py'] }) });
  ok(pt.testCommand === 'pytest -q', 'pytest is preferred only when configured AND installed');
  const pyOnly = detectEnvironment('/ws', 'x', { ...base, isExec: on('python'), ...fsOf({ '/ws': ['tests'], '/ws/tests': ['test_a.py'] }) });
  ok(pyOnly.testCommand === 'python -m unittest discover -s tests -t .', 'a machine with only `python` gets `python` commands');
}

function testOtherProjects() {
  const node = detectEnvironment('/ws', 'app', { ...base, isExec: on('node', 'npm'), ...fsOf({ '/ws': ['package.json'], '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }) }) });
  ok(node.testCommand === 'npm test' && node.buildCommand === 'npm run build' && node.projectKinds.includes('Node/TypeScript'), 'Node project: test/build commands from package.json scripts');
  const placeholder = detectEnvironment('/ws', 'app', { ...base, isExec: on('npm'), ...fsOf({ '/ws': ['package.json'], '/ws/package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }) });
  ok(placeholder.testCommand === undefined, 'the npm-init placeholder test script is not offered as a test command');
  const pnpm = detectEnvironment('/ws', 'app', { ...base, isExec: on('pnpm', 'npm'), ...fsOf({ '/ws': ['package.json', 'pnpm-lock.yaml'], '/ws/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) }) });
  ok(pnpm.testCommand === 'pnpm test', 'the package manager is chosen from the lockfile when it is installed');
  const bad = detectEnvironment('/ws', 'app', { ...base, isExec: on('npm'), ...fsOf({ '/ws': ['package.json'], '/ws/package.json': '{ not json' }) });
  ok(bad.testCommand === undefined && bad.projectKinds.includes('Node/TypeScript'), 'a malformed package.json is tolerated');
  ok(detectEnvironment('/ws', 'r', { ...base, isExec: on('cargo'), ...fsOf({ '/ws': ['Cargo.toml'] }) }).testCommand === 'cargo test', 'Rust: cargo test');
  ok(detectEnvironment('/ws', 'g', { ...base, isExec: on('go'), ...fsOf({ '/ws': ['go.mod'] }) }).testCommand === 'go test ./...', 'Go: go test ./...');
  ok(detectEnvironment('/ws', 'm', { ...base, isExec: on('make'), ...fsOf({ '/ws': ['Makefile'], '/ws/Makefile': 'build:\n\tcc x\ntest:\n\t./t\n' }) }).testCommand === 'make test', 'Makefile with a test target');
  const empty = detectEnvironment('/ws', 'e', { ...base, isExec: () => false, ...fsOf({}) });
  const t = renderEnvironment(empty);
  ok(empty.testCommand === undefined && !/Likely test command/.test(t) && /Environment/.test(t), 'an unknown project makes no test-command claim (never invented)');
  ok(!/Installed:/.test(t), 'nothing installed → no "Installed" line');
}

function testStability() {
  const a = renderEnvironment(detectEnvironment('/ws', 'shop', { ...base, isExec: on('python3', 'git', 'node'), ...fsOf({ '/ws': ['tests'], '/ws/tests': ['test_x.py'] }) }));
  const b = renderEnvironment(detectEnvironment('/ws', 'shop', { ...base, isExec: on('python3', 'git', 'node'), ...fsOf({ '/ws': ['tests'], '/ws/tests': ['test_x.py'] }) }));
  ok(a === b, 'output is deterministic — safe inside the cached system prompt (no timestamps, no ordering noise)');
  // never throws even when the file system misbehaves
  const boom = { readdir: () => { throw new Error('EACCES'); }, readFile: () => { throw new Error('EACCES'); }, exists: () => { throw new Error('x'); } };
  let threw = false;
  let f: any;
  try { f = detectEnvironment('/ws', 'x', { ...base, isExec: () => false, ...(boom as any) }); } catch { threw = true; }
  ok(!threw && f && f.projectKinds.length === 0 && f.testCommand === undefined, 'a file system that throws on every call yields minimal facts, never an exception');
}

function testPromptIntegration() {
  const env = '## Environment (do not guess — this was detected)\n- macOS.';
  const withEnv = buildSystemPrompt('ws', 'agent', { environmentText: env, terse: true });
  ok(withEnv.includes('## Environment (do not guess') && withEnv.includes('AT MOST ONE short sentence') && withEnv.includes('at most 4 short sentences'), 'agent mode: environment section and the terse style are in the system prompt');
  const plain = buildSystemPrompt('ws', 'agent', { environmentText: env, terse: false });
  ok(plain.includes('## Environment') && !plain.includes('AT MOST ONE short sentence') && plain.includes('Be concise in your final answers'), 'terse off → the original style line');
  ok(!buildSystemPrompt('ws', 'plan', { environmentText: env }).includes('## Environment'), 'Plan mode (no tools) omits the environment section');
  ok(!buildSystemPrompt('ws', 'agent', {}).includes('## Environment'), 'no environment provided → no section');
  ok(buildSystemPrompt('ws', 'agent', { environmentText: env, terse: true }) === buildSystemPrompt('ws', 'agent', { environmentText: env, terse: true }), 'the prompt is byte-identical across calls (cache-stable)');
}

function main() {
  testPathScan();
  testPythonProject();
  testOtherProjects();
  testStability();
  testPromptIntegration();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 environment tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 environment tests passed.');
}
main();
