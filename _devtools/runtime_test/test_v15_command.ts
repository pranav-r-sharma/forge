// ============================================================================
// 0.15.0: run_command's `cwd` (src/tools/commandTool.ts resolveCommandCwd). Found by the full-suite run: the model passed the workspace NAME as
// `cwd`; the error was "spawn /bin/sh ENOENT" and it retried the identical call five times. Now: check first, self-correct the workspace-name case,
// and otherwise say exactly what is wrong and list the real folders.
// ============================================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCommandCwd, runCommandTool } from '../../src/tools/commandTool';
import { detectEnvironment, renderEnvironment } from '../../src/agent/environment';

let passed = 0;
let failed = 0;
function ok(cond: any, msg: string) {
  if (cond) { passed++; console.log('ok -', msg); } else { failed++; console.log('NOT OK -', msg); }
}

function ws(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cwd-'));
  const root = path.join(d, 'myproject');
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  return root;
}

function pureTests() {
  const root = ws();
  for (const v of [undefined, '', '.', './', '   ', 42 as any, null as any]) {
    const r = resolveCommandCwd(root, v);
    ok(r.ok && r.cwd === root, `cwd ${JSON.stringify(v)} → the workspace root`);
  }
  const t = resolveCommandCwd(root, 'tests');
  ok(t.ok && t.cwd === path.join(root, 'tests') && !t.note, 'an existing subfolder is used');
  const own = resolveCommandCwd(root, 'myproject');
  ok(own.ok && own.cwd === root && /that is the workspace itself/.test(own.note || ''), "the workspace's own NAME is understood as the root, with a note (the exact mistake from the suite run)");
  ok(resolveCommandCwd(root, 'myproject/').ok, 'including a trailing slash');
  const bad = resolveCommandCwd(root, 'nope');
  ok(!bad.ok && /"nope" does not exist under the workspace root/.test((bad as any).error) && /omit "cwd"/.test((bad as any).error), 'a folder that does not exist gets a clear error, not spawn ENOENT');
  ok(/tests\//.test((bad as any).error) && /src\//.test((bad as any).error) && !/node_modules|\.git/.test((bad as any).error), 'the error lists the real folders (hidden and dependency folders left out)');
  let escaped = ''; try { resolveCommandCwd(root, '../../etc'); } catch (e: any) { escaped = e.message; }
  ok(/outside the workspace/.test(escaped), 'a path escaping the workspace is still refused');
  const fileNotDir = path.join(root, 'a.txt'); fs.writeFileSync(fileNotDir, 'x');
  ok(!resolveCommandCwd(root, 'a.txt').ok, 'a file is not a valid cwd');
}

async function toolTests() {
  const root = ws();
  const ctx: any = { workspaceRoot: vscode.Uri.file(root), cancellation: new vscode.CancellationTokenSource().token, requestCommandApproval: async () => true, startBackgroundCommand: () => ({ ok: false, error: 'n/a' }) };
  const selfName = await runCommandTool({ command: 'pwd', cwd: 'myproject' }, ctx);
  ok(selfName.ok && fs.realpathSync(selfName.content.split('\n')[2].trim()) === fs.realpathSync(root) && /that is the workspace itself/.test(selfName.content), 'REAL command run with the workspace name as cwd: it runs in the root and tells the model why');
  const missing = await runCommandTool({ command: 'pwd', cwd: 'does-not-exist' }, ctx);
  ok(!missing.ok && /does not exist under the workspace root/.test(missing.content) && !/ENOENT/.test(missing.content), 'REAL command with a missing cwd: a helpful error, and no command is run');
  const sub = await runCommandTool({ command: 'pwd', cwd: 'tests' }, ctx);
  ok(sub.ok && /tests\s*$/.test(sub.content.trim().split('\n')[2].trim()), 'a real subfolder still works');
}

function environmentWording() {
  const facts = detectEnvironment('/x/t05-large-file', 't05-large-file', { platform: 'darwin', arch: 'arm64', shell: '/bin/zsh', pathEnv: '/bin', isExec: () => false, readdir: () => [], readFile: () => undefined, exists: () => false });
  const text = renderEnvironment(facts);
  ok(!text.includes('t05-large-file'), "the environment section no longer contains the workspace name (it read like a folder to the model)");
  ok(/root folder by default/.test(text) && /never the project's own name/.test(text), 'and it says plainly that the root is the default and the project name is not a cwd');
}

async function main() {
  pureTests();
  await toolTests();
  environmentWording();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 command cwd tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 command cwd tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_command.ts:', err); process.exit(1); });
