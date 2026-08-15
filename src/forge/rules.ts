import * as vscode from 'vscode';
import { parseFrontmatter } from '../util/frontmatter';
import { matchesAnyGlob } from '../util/glob';
import { logger } from '../util/logger';

export interface ForgeRule {
  fileName: string;
  description?: string;
  alwaysApply: boolean;
  globs: string[];
  body: string;
}

/**
 * Loads project rules from `.forge/rules/*.md` (Cursor `.cursor/rules/*.mdc`
 * equivalent) plus a legacy single `.forge/rules.md` file (Cursor
 * `.cursorrules` equivalent, always-on, no frontmatter required). Rules are
 * re-read on demand rather than cached across the whole session so editing a
 * rule file takes effect on the very next message without a reload.
 */
export class RulesEngine {
  constructor(private workspaceRoot: vscode.Uri) {}

  async loadAll(): Promise<ForgeRule[]> {
    const rules: ForgeRule[] = [];

    // Legacy single-file form: .forge/rules.md, always-on, plain body.
    const legacyUri = vscode.Uri.joinPath(this.workspaceRoot, '.forge', 'rules.md');
    const legacyText = await readIfExists(legacyUri);
    if (legacyText !== undefined) {
      rules.push({ fileName: '.forge/rules.md', alwaysApply: true, globs: [], body: legacyText.trim() });
    }

    // Directory form: .forge/rules/*.md, with frontmatter.
    const dirUri = vscode.Uri.joinPath(this.workspaceRoot, '.forge', 'rules');
    let entries: [string, number][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      /* no rules directory yet */
    }
    for (const [name, type] of entries) {
      if (type !== 1 /* File */ || !name.endsWith('.md')) continue;
      const fileUri = vscode.Uri.joinPath(dirUri, name);
      const text = await readIfExists(fileUri);
      if (text === undefined) continue;
      try {
        const { attrs, body } = parseFrontmatter(text);
        const globs = Array.isArray(attrs.globs) ? attrs.globs : typeof attrs.globs === 'string' ? [attrs.globs] : [];
        rules.push({
          fileName: `.forge/rules/${name}`,
          description: typeof attrs.description === 'string' ? attrs.description : undefined,
          alwaysApply: attrs.alwaysApply === true || (globs.length === 0 && attrs.alwaysApply !== false),
          globs,
          body: body.trim(),
        });
      } catch (err) {
        logger.warn(`Failed to parse rule file ${name}`, String(err));
      }
    }

    return rules;
  }

  /** Rules that should be injected for the given active file (or just always-on rules if none is open). */
  async applicable(activeFileRelPath?: string): Promise<ForgeRule[]> {
    const all = await this.loadAll();
    return all.filter((r) => r.alwaysApply || (activeFileRelPath && matchesAnyGlob(activeFileRelPath, r.globs)));
  }

  async renderForPrompt(activeFileRelPath?: string): Promise<string> {
    const rules = await this.applicable(activeFileRelPath);
    if (rules.length === 0) return '';
    const sections = rules.map((r) => `### ${r.fileName}${r.description ? ` — ${r.description}` : ''}\n${r.body}`);
    return `## Project rules (from .forge/rules — follow these strictly)\n\n${sections.join('\n\n')}`;
  }
}

async function readIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}
