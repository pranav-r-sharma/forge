import { parseFrontmatter } from '../../src/util/frontmatter';
import { globToRegExp, matchesAnyGlob } from '../../src/util/glob';

function assert(cond: any, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('ok -', msg);
}

// ---- frontmatter ----
{
  const { attrs, body } = parseFrontmatter(`---
description: "Some rule"
globs: ["**/*.ts", "src/**/*.tsx"]
alwaysApply: false
---

Body text here.
Second line.`);
  assert(attrs.description === 'Some rule', 'parses quoted string');
  assert(Array.isArray(attrs.globs) && attrs.globs.length === 2 && attrs.globs[0] === '**/*.ts', 'parses array of globs');
  assert(attrs.alwaysApply === false, 'parses boolean false');
  assert(body.trim() === 'Body text here.\nSecond line.', 'extracts body after frontmatter');
}
{
  const { attrs, body } = parseFrontmatter('no frontmatter here, just body text');
  assert(Object.keys(attrs).length === 0, 'no frontmatter -> empty attrs');
  assert(body === 'no frontmatter here, just body text', 'no frontmatter -> body is whole text');
}
{
  const { attrs } = parseFrontmatter(`---
alwaysApply: true
---
body`);
  assert(attrs.alwaysApply === true, 'parses boolean true');
}

// ---- glob ----
{
  assert(globToRegExp('**/*.ts').test('src/foo/bar.ts'), '**/*.ts matches nested .ts file');
  assert(globToRegExp('**/*.ts').test('bar.ts'), '**/*.ts matches top-level .ts file too');
  assert(!globToRegExp('**/*.ts').test('bar.tsx'), '**/*.ts does not match .tsx');
  assert(globToRegExp('src/**/*.tsx').test('src/a/b/c.tsx'), 'src/**/*.tsx matches deep nesting');
  assert(!globToRegExp('src/**/*.tsx').test('lib/a/c.tsx'), 'src/**/*.tsx does not match outside src/');
  assert(globToRegExp('*.md').test('README.md'), '*.md matches top-level file');
  assert(!globToRegExp('*.md').test('docs/README.md'), '*.md (no **) does not match nested path');
  assert(matchesAnyGlob('src/foo.ts', ['*.md', '**/*.ts']), 'matchesAnyGlob true when any pattern matches');
  assert(!matchesAnyGlob('src/foo.py', ['*.md', '**/*.ts']), 'matchesAnyGlob false when none match');
}

console.log('\nAll v2 runtime tests passed.');
