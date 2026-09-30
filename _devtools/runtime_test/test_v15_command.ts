// ============================================================================
// 0.15.0: run_command's `cwd` (src/tools/commandTool.ts resolveCommandCwd). Found by the full-suite run: the model passed the workspace NAME as
// `cwd`; the error was "spawn /bin/sh ENOENT" and it retried the identical call five times. Now: check first, self-correct the workspace-name case,
// and otherwise say exactly what is wrong and list the real folders.
// ============================================================================
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveRunCommandString, shellQuoteJoinArgv } from '../../src/tools/argErrors';
import { resolveCommandCwd, runCommandTool, isDangerousCommand } from '../../src/tools/commandTool';
import { readFileTool } from '../../src/tools/fileTools';
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

  // end-to-end plumbing check for the workspace-wipe guard: runCommandTool must actually pass its
  // workspaceRoot.fsPath through to requestCommandApproval, not just isDangerousCommand in isolation.
  let seenWorkspaceRootArg: string | undefined;
  const denyingCtx: any = {
    workspaceRoot: vscode.Uri.file(root), cancellation: new vscode.CancellationTokenSource().token,
    requestCommandApproval: async (_cmd: string, _callId: string, wr?: string) => { seenWorkspaceRootArg = wr; return false; },
    startBackgroundCommand: () => ({ ok: false, error: 'n/a' }),
  };
  const wipe = await runCommandTool({ command: `rm -rf "${root}"` }, denyingCtx);
  ok(!wipe.ok && /did not approve/.test(wipe.content), 'runCommandTool actually blocks when approval is denied (real end-to-end path, not just the pure function)');
  ok(seenWorkspaceRootArg === root, 'and it passed the real workspace root through to requestCommandApproval, so the guard has what it needs to fire');
}

function environmentWording() {
  const facts = detectEnvironment('/x/t05-large-file', 't05-large-file', { platform: 'darwin', arch: 'arm64', shell: '/bin/zsh', pathEnv: '/bin', isExec: () => false, readdir: () => [], readFile: () => undefined, exists: () => false });
  const text = renderEnvironment(facts);
  ok(!text.includes('t05-large-file'), "the environment section no longer contains the workspace name (it read like a folder to the model)");
  ok(/root folder by default/.test(text) && /never the project's own name/.test(text), 'and it says plainly that the root is the default and the project name is not a cwd');
}

// t07-build-from-scratch acceptance-test finding (see PROGRESS.md): a model stuck on a misdiagnosed test
// failure ran `rm -rf "<absolute workspace path>"` to "start over" — the pre-existing dangerous-command
// denylist only guarded `rm -rf /` and `rm -rf ~`, not the agent's own workspace root, so it went through
// unguarded and every subsequent run_command call failed with no way to recover.
function dangerousCommandTests() {
  const root = ws();
  ok(isDangerousCommand(`rm -rf "${root}"`, root), 'rm -rf on the exact workspace root is flagged, given workspace context');
  ok(isDangerousCommand(`rm -fr "${root}"`, root), 'flags reversed (-fr) is also flagged');
  ok(isDangerousCommand(`rm -r -f "${root}"`, root), 'separate short flags (-r -f) are also flagged');
  ok(isDangerousCommand(`rm --recursive --force "${root}"`, root), 'long-form flags (--recursive --force) are also flagged');
  ok(isDangerousCommand('rm -rf .', root), 'a bare "rm -rf ." (the current directory) is flagged too — same catastrophic outcome regardless of exactly what it resolves to');
  ok(isDangerousCommand('rm -rf ./', root), 'and "./"');
  ok(isDangerousCommand(`rm -rf "${path.dirname(root)}"`, root), 'rm -rf on an ANCESTOR of the workspace root is flagged (it would take the workspace down with it)');
  ok(isDangerousCommand(`echo cleaning up && rm -rf "${root}"`, root), 'still caught when chained after other commands (&&)');
  ok(!isDangerousCommand('rm -rf node_modules', root), 'rm -rf on an ordinary SUBfolder is NOT flagged — the agent is trusted to manage its own workspace contents');
  ok(!isDangerousCommand(`rm -rf "${path.join(root, 'contacts')}"`, root), 'rm -rf on a subfolder by absolute path is also not flagged');
  ok(!isDangerousCommand(`rm -rf "${root}"`), 'without workspace context (no third arg) the new check never fires — pure backward compatibility, never a new false positive');
  ok(isDangerousCommand('rm -rf /'), "the pre-existing rm -rf / guard is unaffected (doesn't need workspace context)");
}

function harnessArgTests() {
  ok(
    shellQuoteJoinArgv(['python3', '-m', 'py_compile', 'main.py']) === 'python3 -m py_compile main.py',
    'argv array joins to shell command',
  );
  ok(resolveRunCommandString(['echo', 'hello world']) === 'echo "hello world"', 'array command with spaces is shell-quoted');
  ok(resolveRunCommandString('python3 main.py') === 'python3 main.py', 'string command unchanged');
}

async function readFileAliasTests() {
  const root = ws();
  const big = path.join(root, 'big.py');
  fs.writeFileSync(big, Array.from({ length: 250 }, (_, i) => `# line ${i + 1}`).join('\n'));
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(root),
    config: { maxContextFileKB: 1 },
    readEffective: async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath, 'utf8'),
  };
  const paged = await readFileTool({ path: 'big.py', line_start: 1, line_end: 3 }, ctx);
  ok(paged.ok && paged.content.includes('lines 1-3'), 'read_file accepts line_start/line_end aliases');
}

async function runCommandArrayTests() {
  const root = ws();
  const ctx: any = {
    workspaceRoot: vscode.Uri.file(root),
    cancellation: new vscode.CancellationTokenSource().token,
    requestCommandApproval: async () => true,
    startBackgroundCommand: () => ({ ok: false, error: 'n/a' }),
  };
  const r = await runCommandTool({ command: ['python3', '-c', 'print(7)'], timeout: 999 }, ctx);
  ok(r.ok && r.content.includes('7') && /no arg "timeout"/.test(r.content), 'array command runs and unknown timeout is explained');
}

async function main() {
  pureTests();
  harnessArgTests();
  await toolTests();
  await readFileAliasTests();
  await runCommandArrayTests();
  environmentWording();
  dangerousCommandTests();
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) { console.log('Some v0.15.0 command cwd tests FAILED.'); process.exit(1); }
  console.log('All v0.15.0 command cwd tests passed.');
}
main().catch((err) => { console.error('Uncaught error in test_v15_command.ts:', err); process.exit(1); });
