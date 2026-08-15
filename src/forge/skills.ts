import * as vscode from 'vscode';
import { parseFrontmatter } from '../util/frontmatter';

export interface ForgeSkill {
  name: string;
  description?: string;
  template: string;
}

/**
 * Loads reusable prompt templates from `.forge/skills/*.md` — Forge's
 * equivalent of Cursor's `.cursor/commands/*.md` custom slash commands (and,
 * being freeform saved prompt text, also covers what Cursor called
 * Notepads). Invoked in chat as `/name rest of your message`; `{{input}}` in
 * the template is replaced with whatever follows the command name, and if
 * the template doesn't mention `{{input}}` the rest of the message is just
 * appended after it.
 */
export class SkillsEngine {
  constructor(private workspaceRoot: vscode.Uri) {}

  async loadAll(): Promise<ForgeSkill[]> {
    const dirUri = vscode.Uri.joinPath(this.workspaceRoot, '.forge', 'skills');
    let entries: [string, number][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return [];
    }
    const skills: ForgeSkill[] = [];
    for (const [name, type] of entries) {
      if (type !== 1 /* File */ || !name.endsWith('.md')) continue;
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dirUri, name));
        const { attrs, body } = parseFrontmatter(Buffer.from(bytes).toString('utf8'));
        skills.push({
          name: name.replace(/\.md$/, ''),
          description: typeof attrs.description === 'string' ? attrs.description : undefined,
          template: body.trim(),
        });
      } catch {
        /* skip unreadable/malformed skill file */
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Parses `/name rest of message` and expands it against a matching skill template, if any. */
  async expand(text: string): Promise<{ expanded: string; skillUsed?: string } | undefined> {
    const m = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
    if (!m) return undefined;
    const [, name, rest] = m;
    const skills = await this.loadAll();
    const skill = skills.find((s) => s.name === name);
    if (!skill) return undefined;
    const expanded = skill.template.includes('{{input}}')
      ? skill.template.replace(/\{\{input\}\}/g, rest)
      : rest
        ? `${skill.template}\n\n${rest}`
        : skill.template;
    return { expanded, skillUsed: skill.name };
  }
}
