import { ProviderCredentials, SearchProvider, WebSearchOptions, WebSearchResult } from '../types';

/**
 * SearXNG — a self-hosted, open-source meta-search engine that itself
 * aggregates Google/Bing/Brave/DuckDuckGo/etc. Points at whatever instance
 * URL the user configures (`forge.webSearch.searxngUrl`, e.g.
 * "https://searx.example.com" or a local "http://localhost:8080"). This is
 * the closest thing to a fully self-hostable, no-third-party-API-key option
 * — a good fit for Forge's local-first ethos if you're willing to run the
 * instance yourself. Requires the instance to have `json` enabled under its
 * `search:formats` config — most public instances disable it by default (to
 * discourage scraping their free service), so this works best against an
 * instance you control.
 */
export const searxngProvider: SearchProvider = {
  id: 'searxng',
  displayName: 'SearXNG (self-hosted)',
  requiresApiKey: false,
  isConfigured: (creds) => !!creds.instanceUrl,
  async search(query: string, creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]> {
    if (!creds.instanceUrl) throw new Error('SearXNG requires an instance URL (forge.webSearch.searxngUrl).');
    const base = creds.instanceUrl.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status} — is "json" enabled under this instance's search:formats config?`);
    const data: any = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) return [];
    return results
      .slice(0, Math.max(1, opts.count))
      .map(
        (r: any): WebSearchResult => ({
          title: String(r?.title || r?.url || 'Untitled'),
          url: String(r?.url || ''),
          snippet: String(r?.content || ''),
          publishedAt: r?.publishedDate ? String(r.publishedDate) : undefined,
          source: 'searxng',
        })
      )
      .filter((r: WebSearchResult) => !!r.url);
  },
};
