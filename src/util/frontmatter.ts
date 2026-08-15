/**
 * Minimal YAML-frontmatter parser — deliberately not a real YAML parser (no
 * npm dependency available/needed). Handles the small subset Forge's own
 * rule/skill files use: `---` fenced header with `key: value`,
 * `key: true|false`, `key: [a, b, c]`, and quoted strings.
 */
export interface ParsedFrontmatter {
  attrs: Record<string, any>;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(raw);
  if (!match) return { attrs: {}, body: raw };

  const [, header, body] = match;
  const attrs: Record<string, any> = {};
  for (const line of header.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const [, key, rawValue] = kv;
    attrs[key] = parseScalar(rawValue.trim());
  }
  return { attrs, body };
}

function parseScalar(value: string): any {
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s.length > 0);
  }
  return stripQuotes(value);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
