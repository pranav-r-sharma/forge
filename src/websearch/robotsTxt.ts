/**
 * Minimal robots.txt parser for web_fetch's polite-by-default behavior
 * (forge.webSearch.respectRobotsTxt, default true) — production-grade web
 * tooling checks this before fetching, and it's cheap to get right for the
 * common cases even without a full crawler-grade implementation.
 *
 * Supports: per-User-agent groups (falls back to `*`), Disallow/Allow with
 * `*` wildcards and a trailing `$` end-anchor (the de-facto extensions most
 * real robots.txt files use), longest-match-wins with Allow beating Disallow
 * on an exact tie. Does NOT support crawl-delay pacing or sitemap discovery
 * — irrelevant for a single on-demand fetch rather than a crawler.
 *
 * Fail-open by design: a missing/unreachable/unparseable robots.txt means
 * "everything allowed" (RFC 9309's own default), never "block everything" —
 * see fetchService.ts for how a failed robots.txt fetch is treated.
 */

interface Rule {
  allow: boolean;
  pattern: RegExp;
  specificity: number;
}

export interface RobotsRules {
  rules: Rule[];
}

export const ALLOW_ALL: RobotsRules = { rules: [] };

/** Parses robots.txt text, keeping only the directive group that applies to `userAgentToken` (case-insensitive substring match against each group's User-agent line), falling back to the `*` group if no specific match exists. */
export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRules {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());

  // First pass: split into groups, each starting at one-or-more consecutive
  // "User-agent:" lines and running until the next such run.
  type Group = { agents: string[]; directives: { key: string; value: string }[] };
  const groups: Group[] = [];
  let current: Group | undefined;
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.directives.length > 0) {
        current = { agents: [], directives: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current) {
      current.directives.push({ key, value });
    }
  }

  const ua = userAgentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = specific.length > 0 ? specific : wildcard;

  const rules: Rule[] = [];
  for (const g of applicable) {
    for (const d of g.directives) {
      if (d.key !== 'allow' && d.key !== 'disallow') continue;
      if (!d.value) {
        // An empty Disallow means "disallow nothing" per spec — skip rather
        // than emitting a pattern that matches everything.
        if (d.key === 'disallow') continue;
      }
      rules.push({ allow: d.key === 'allow', pattern: robotsPatternToRegex(d.value), specificity: d.value.length });
    }
  }
  return { rules };
}

function robotsPatternToRegex(pattern: string): RegExp {
  const endAnchor = pattern.endsWith('$');
  const body = endAnchor ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${endAnchor ? '$' : ''}`);
}

/** Whether `path` (e.g. "/blog/post-1") is allowed under the parsed rules — longest matching pattern wins, Allow beats Disallow on a tie, no match = allowed. */
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  let best: Rule | undefined;
  for (const rule of rules.rules) {
    if (!rule.pattern.test(path)) continue;
    if (!best || rule.specificity > best.specificity || (rule.specificity === best.specificity && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
