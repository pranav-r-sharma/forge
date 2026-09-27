import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Facts about the machine and the project that a local model would otherwise GUESS (and waste steps on): which interpreters/tools exist, and the
 * project's likely test command. Found by the first end-to-end run: the model tried `python` on a machine that only has `python3`, then ran tests
 * from the wrong directory — four wasted steps (~11 s) on a 64 s task. Deterministic, presence-only (no version probing, no subprocesses), cheap,
 * and injected into the STABLE part of the system prompt so it never invalidates the prompt cache between steps.
 */
export interface EnvironmentFacts {
  platform: string;
  arch: string;
  shell: string;
  workspaceName: string;
  available: string[];
  missing: string[];
  testCommand?: string;
  buildCommand?: string;
  projectKinds: string[];
}

const TOOLS_TO_CHECK = ['python3', 'python', 'pip3', 'pytest', 'node', 'npm', 'pnpm', 'yarn', 'git', 'rg', 'make', 'cargo', 'go', 'java', 'dotnet', 'ruby', 'docker'];

/** True if `cmd` exists as an executable file in one of the PATH directories. Pure given its inputs. */
export function findOnPath(cmd: string, pathEnv: string, isExec: (p: string) => boolean = defaultIsExec): boolean {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir && isExec(path.join(dir, cmd))) return true;
  }
  return false;
}
function defaultIsExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface DetectDeps {
  pathEnv?: string;
  isExec?: (p: string) => boolean;
  platform?: string;
  arch?: string;
  shell?: string;
  readdir?: (p: string) => string[];
  readFile?: (p: string) => string | undefined;
  exists?: (p: string) => boolean;
}

/** Detects tools and project conventions for a workspace. Never throws; anything unreadable is simply omitted. */
export function detectEnvironment(workspaceRoot: string, workspaceName: string, deps: DetectDeps = {}): EnvironmentFacts {
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
  const isExec = deps.isExec ?? defaultIsExec;
  // Every file-system access is guarded: a misbehaving or injected reader can never make detection throw — that input is just treated as absent.
  const guard = <A extends unknown[], R>(f: (...a: A) => R, dflt: R) => (...a: A): R => { try { return f(...a); } catch { return dflt; } };
  const exists = guard(deps.exists ?? ((p: string) => fs.existsSync(p)), false);
  const readdir = guard(deps.readdir ?? ((p: string) => fs.readdirSync(p)), [] as string[]);
  const readFile = guard(deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8') as string | undefined), undefined as string | undefined);
  const has = (c: string) => findOnPath(c, pathEnv, isExec);

  const available = TOOLS_TO_CHECK.filter(has);
  const missing = TOOLS_TO_CHECK.filter((c) => !has(c));
  const top = readdir(workspaceRoot);
  const kinds: string[] = [];
  let testCommand: string | undefined;
  let buildCommand: string | undefined;

  const pkgText = top.includes('package.json') ? readFile(path.join(workspaceRoot, 'package.json')) : undefined;
  if (pkgText) {
    kinds.push('Node/TypeScript');
    try {
      const scripts = (JSON.parse(pkgText).scripts || {}) as Record<string, string>;
      const runner = top.includes('pnpm-lock.yaml') && has('pnpm') ? 'pnpm' : top.includes('yarn.lock') && has('yarn') ? 'yarn' : 'npm';
      if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)) testCommand = runner === 'npm' ? 'npm test' : `${runner} test`;
      if (typeof scripts.build === 'string') buildCommand = runner === 'npm' ? 'npm run build' : `${runner} build`;
    } catch {
      /* malformed package.json: leave it out */
    }
  }
  const isPython = top.some((f) => f === 'pyproject.toml' || f === 'setup.py' || f === 'requirements.txt' || f === 'pytest.ini' || f === 'tox.ini') || top.some((f) => f.endsWith('.py')) || top.includes('tests') && readdir(path.join(workspaceRoot, 'tests')).some((f) => f.endsWith('.py'));
  if (isPython) {
    kinds.push('Python');
    if (!testCommand) {
      const py = has('python3') ? 'python3' : has('python') ? 'python' : 'python3';
      const pytestConfigured = top.includes('pytest.ini') || top.includes('conftest.py') || /\[tool\.pytest/.test(readFile(path.join(workspaceRoot, 'pyproject.toml')) || '');
      const testsDir = top.includes('tests') ? 'tests' : top.includes('test') ? 'test' : undefined;
      if (pytestConfigured && has('pytest')) testCommand = 'pytest -q';
      else if (testsDir) testCommand = `${py} -m unittest discover -s ${testsDir} -t .`;
    }
  }
  if (!testCommand && top.includes('Cargo.toml')) { kinds.push('Rust'); testCommand = 'cargo test'; buildCommand = buildCommand ?? 'cargo build'; }
  if (!testCommand && top.includes('go.mod')) { kinds.push('Go'); testCommand = 'go test ./...'; buildCommand = buildCommand ?? 'go build ./...'; }
  if (!testCommand && top.includes('Makefile')) { const mk = readFile(path.join(workspaceRoot, 'Makefile')) || ''; if (/^test\s*:/m.test(mk)) testCommand = 'make test'; }
  if (!kinds.length && exists(path.join(workspaceRoot, '.git'))) kinds.push('git repository');

  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    shell: path.basename(deps.shell ?? process.env.SHELL ?? 'sh'),
    workspaceName,
    available,
    missing,
    testCommand,
    buildCommand,
    projectKinds: kinds,
  };
}

/** The prompt section. Stable for a given machine+project, so it is safe in the cached system prompt. */
export function renderEnvironment(f: EnvironmentFacts): string {
  const osName = f.platform === 'darwin' ? 'macOS' : f.platform === 'win32' ? 'Windows' : f.platform === 'linux' ? 'Linux' : f.platform;
  const lines = [`## Environment (do not guess — this was detected)`, `- ${osName} (${f.arch}), shell: ${f.shell}. Commands run from the project's root folder by default — pass "cwd" only to run inside a subfolder, as a path relative to that root (never the project's own name).`];
  if (f.projectKinds.length) lines.push(`- Project type: ${f.projectKinds.join(', ')}.`);
  if (f.available.length) lines.push(`- Installed: ${f.available.join(', ')}.`);
  const notes: string[] = [];
  if (f.missing.includes('python') && f.available.includes('python3')) notes.push('`python` is NOT installed — use `python3`');
  if (f.missing.includes('pip') && f.available.includes('pip3')) notes.push('use `pip3`, not `pip`');
  if (f.missing.includes('pytest') && f.available.includes('python3')) notes.push('`pytest` is not installed (use `python3 -m unittest` for unittest-style tests)');
  const notInstalled = f.missing.filter((c) => ['node', 'npm', 'git', 'rg', 'cargo', 'go', 'make'].includes(c));
  if (notInstalled.length) notes.push(`not installed: ${notInstalled.join(', ')}`);
  if (notes.length) lines.push(`- ${notes.join('; ')}.`);
  if (f.testCommand) lines.push(`- Likely test command (run from the workspace root): \`${f.testCommand}\`.`);
  if (f.buildCommand) lines.push(`- Likely build command: \`${f.buildCommand}\`.`);
  return lines.join('\n');
}
