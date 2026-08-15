/**
 * Minimal glob matcher (no npm dependency) supporting the subset used by
 * rule/skill frontmatter: `*` (any chars except `/`), `**` (any chars
 * including `/`), `?` (single char), and literal segments.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // consume an immediately-following slash so "**/foo" also matches "foo"
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(relPath);
    } catch {
      return false;
    }
  });
}
