import { ProviderCredentials, SearchProvider, WebSearchOptions, WebSearchResult } from '../types';
import { decodeEntities } from '../htmlExtract';

/**
 * DuckDuckGo's no-JS "html" results page (https://html.duckduckgo.com/html/)
 * scraped as the always-available, zero-configuration fallback — same role
 * as `search_codebase`'s keyword-search fallback when no embedding model is
 * installed (see indexing/workspaceIndex.ts). This is NOT an official API:
 * there is no documented, supported DuckDuckGo web-search API, so every
 * "DuckDuckGo search" integration without a paid contract works this way.
 * That means it's inherently more fragile than the real APIs above — if
 * DuckDuckGo changes this page's markup, the regex-based extraction below
 * breaks until updated. It exists so web_search works out of the box with
 * zero setup; configuring a real provider (Brave/Tavily/Google/SearXNG) is
 * recommended for anything beyond casual/occasional use — see README.
 */
export const duckduckgoProvider: SearchProvider = {
  id: 'duckduckgo',
  displayName: 'DuckDuckGo (HTML scrape, no API key)',
  requiresApiKey: false,
  isConfigured: () => true,
  async search(query: string, _creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]> {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: {
        // A browser-like UA is necessary here — DuckDuckGo's HTML endpoint
        // 403s obvious non-browser clients. This is standard practice for
        // this specific well-known no-API fallback (see module doc comment)
        // and not used anywhere else in Forge, which otherwise has no
        // reason to disguise what it is.
        'User-Agent': 'Mozilla/5.0 (compatible; ForgeAgent/1.0; +local-vscode-extension)',
        Accept: 'text/html',
      },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTML search HTTP ${res.status}`);
    const html = await res.text();
    return parseDuckDuckGoHtml(html).slice(0, Math.max(1, opts.count));
  },
};

/** Exported for unit testing against a canned HTML fixture without a real network call. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const titleRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) {
    const url = resolveDuckDuckGoHref(m[1]);
    const title = cleanFragment(m[2]);
    if (url && title) titles.push({ url, title });
  }

  const snippets: string[] = [];
  while ((m = snippetRe.exec(html))) {
    snippets.push(cleanFragment(m[1]));
  }

  return titles.map((t, i) => ({
    title: t.title,
    url: t.url,
    snippet: snippets[i] || '',
    source: 'duckduckgo',
  }));
}

/** DuckDuckGo's HTML results wrap the real URL in a `/l/?uddg=<encoded>` redirect link; unwrap it so web_fetch gets the actual destination, not a DuckDuckGo redirect hop. */
function resolveDuckDuckGoHref(href: string): string {
  const withScheme = href.startsWith('//') ? `https:${href}` : href;
  try {
    const parsed = new URL(withScheme, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return parsed.toString();
  } catch {
    return href.startsWith('http') ? href : '';
  }
}

function cleanFragment(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
