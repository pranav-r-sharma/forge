import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { extractTaskCommandForms } from './claimChecker';
import { ForgeMode, modeSupportsVerifyCommand } from './modes';
import { isDangerousCommand } from '../tools/commandTool';

export type VerifyBeforeDoneMode = 'off' | 'auto' | 'custom';

const ACCEPTANCE_COMMAND_RE =
  /(?:check\.sh|scripts\/check\.sh|npm test|pnpm test|yarn test|pytest|unittest discover|cargo test|go test|make (?:test|check))/i;

const SHELL_LIKE = /^(?:\.\/|bash |sh |python3? |npm |pnpm |yarn |pytest|cargo |go |make )/i;

/** Full-string shapes produced by {@link detectAutoVerifyCommand} (safe to run as-is). */
const KNOWN_VERIFY_CHECK_FORM_RE: RegExp[] = [
  /^bash check\.sh$/i,
  /^bash scripts\/check\.sh$/i,
  /^(npm|pnpm|yarn) test$/i,
  /^pytest -q$/i,
  /^python3 -m unittest discover -s tests -p 'test_\*\.py'$/,
  /^make (?:test|check)$/i,
  /^cargo test$/i,
  /^go test \.\/\.\.\.$/,
];

function normalizeVerifyCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function hasShellChainingOrInjection(command: string): boolean {
  if (/;/.test(command)) return true;
  if (/&&/.test(command)) return true;
  if (/\|\|/.test(command)) return true;
  if (/>/.test(command)) return true;
  if (/`/.test(command)) return true;
  if (/\$\s*\(/.test(command)) return true;
  return command.replace(/\|\|/g, '').includes('|');
}

function isKnownVerifyCheckForm(command: string): boolean {
  const norm = normalizeVerifyCommand(command);
  return KNOWN_VERIFY_CHECK_FORM_RE.some((re) => re.test(norm));
}

/** User-named acceptance commands must be a single safe check — no dangerous or chained shell. */
export function isAcceptableUserAcceptanceVerifyCommand(command: string, workspaceRoot: string): boolean {
  const norm = normalizeVerifyCommand(command);
  if (!norm) return false;
  if (isDangerousCommand(norm, workspaceRoot)) return false;
  if (hasShellChainingOrInjection(norm) && !isKnownVerifyCheckForm(norm)) return false;
  return true;
}

/** Command the user named in the task as the acceptance / verification step — wins over auto-detect. */
export function extractAcceptanceCheckCommand(userMessage: string): string | undefined {
  const forms = extractTaskCommandForms(userMessage);
  for (const f of forms) {
    if (ACCEPTANCE_COMMAND_RE.test(f)) return f;
  }
  if (/\b(?:acceptance|definition of done|verify (?:with|by|using)|run (?:the )?check)\b/i.test(userMessage)) {
    for (const f of forms) {
      if (SHELL_LIKE.test(f)) return f;
    }
  }
  return undefined;
}

export interface VerifyDetectDeps {
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | undefined;
  readdir?: (p: string) => string[];
  pathExecutable?: (cmd: string) => boolean;
  pytestImportable?: boolean;
}

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function defaultReadFile(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function defaultPathExecutable(cmd: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const full = path.join(dir, cmd);
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return true;
    } catch {
      /* next */
    }
  }
  return false;
}

function defaultPytestImportable(): boolean {
  if (defaultPathExecutable('pytest')) return true;
  try {
    const r = spawnSync('python3', ['-c', 'import pytest'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Fixed allowlist of workspace checks (auto mode only — never model-chosen).
 * Order matches the instruction-following plan proposal 4.
 */
export function detectAutoVerifyCommand(workspaceRoot: string, deps: VerifyDetectDeps = {}): string | undefined {
  const exists = deps.exists ?? defaultExists;
  const readFile = deps.readFile ?? defaultReadFile;
  const readdir = deps.readdir ?? defaultReaddir;
  const pathExecutable = deps.pathExecutable ?? defaultPathExecutable;
  const pytestImportable = deps.pytestImportable ?? defaultPytestImportable();

  const root = workspaceRoot;
  if (exists(path.join(root, 'check.sh'))) return 'bash check.sh';
  if (exists(path.join(root, 'scripts', 'check.sh'))) return 'bash scripts/check.sh';

  const pkgPath = path.join(root, 'package.json');
  if (exists(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFile(pkgPath) || '{}').scripts || {}) as Record<string, string>;
      const test = scripts.test;
      if (typeof test === 'string' && test.length > 0 && !/no test specified/i.test(test)) {
        const top = readdir(root);
        const runner =
          top.includes('pnpm-lock.yaml') && pathExecutable('pnpm')
            ? 'pnpm'
            : top.includes('yarn.lock') && pathExecutable('yarn')
              ? 'yarn'
              : 'npm';
        return runner === 'npm' ? 'npm test' : `${runner} test`;
      }
    } catch {
      /* malformed */
    }
  }

  const top = readdir(root);
  const hasTestsDir = top.includes('tests');
  const hasRootTestPy = top.some((f) => /^test_.*\.py$/i.test(f));
  const pyproject = readFile(path.join(root, 'pyproject.toml')) || '';
  const pytestConfigured =
    top.includes('pytest.ini') ||
    top.includes('conftest.py') ||
    /\[tool\.pytest/.test(pyproject);

  if ((hasTestsDir || hasRootTestPy || pytestConfigured) && pytestImportable) {
    return 'pytest -q';
  }
  if (hasTestsDir || hasRootTestPy) {
    const testsDir = hasTestsDir ? 'tests' : '.';
    return `python3 -m unittest discover -s ${testsDir} -p 'test_*.py'`;
  }

  const makefile = readFile(path.join(root, 'Makefile'));
  if (makefile) {
    if (/^test\s*:/m.test(makefile)) return 'make test';
    if (/^check\s*:/m.test(makefile)) return 'make check';
  }

  if (exists(path.join(root, 'Cargo.toml'))) return 'cargo test';
  if (exists(path.join(root, 'go.mod'))) return 'go test ./...';

  return undefined;
}

export interface ResolveVerifyCommandInput {
  mode: ForgeMode;
  verifyBeforeDone: VerifyBeforeDoneMode;
  settingVerifyCommand: string;
  sessionVerifyCommand?: string;
  userMessage: string;
  workspaceRoot: string;
  turnWroteFiles: boolean;
  detectDeps?: VerifyDetectDeps;
}

/** Effective definition-of-done command for this final-answer attempt. */
export function resolveVerifyCommandForFinal(i: ResolveVerifyCommandInput): string | undefined {
  if (!modeSupportsVerifyCommand(i.mode)) return undefined;

  const session = i.sessionVerifyCommand?.trim();
  if (session) return session;

  if (!i.turnWroteFiles) return undefined;

  if (i.verifyBeforeDone === 'off') return undefined;

  if (i.verifyBeforeDone === 'custom') {
    const cmd = i.settingVerifyCommand.trim();
    return cmd || undefined;
  }

  const fromUser = extractAcceptanceCheckCommand(i.userMessage);
  if (fromUser && isAcceptableUserAcceptanceVerifyCommand(fromUser, i.workspaceRoot)) return fromUser;

  return detectAutoVerifyCommand(i.workspaceRoot, i.detectDeps);
}

export function formatVerifyFinalNote(command: string, ok: boolean): string {
  return `\n\n---\n**Verify:** \`${command}\` — ${ok ? 'passed' : 'failed'}.`;
}
