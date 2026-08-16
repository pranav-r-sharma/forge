import { ProviderCredentials, SearchProvider, WebSearchOptions, WebSearchResult } from '../types';

/**
 * Brave Search API — https://api.search.brave.com/res/v1/web/search.
 * Auth via the `X-Subscription-Token` header. Verified against Brave's
 * current API docs (api-dashboard.search.brave.com) rather than assumed
 * from training data, since this kind of endpoint/param detail drifts.
 */
export const braveProvider: SearchProvider = {
  id: 'brave',
  displayName: 'Brave Search',
  requiresApiKey: true,
  isConfigured: (creds) => !!creds.apiKey,
  async search(query: string, creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]> {
    if (!creds.apiKey) throw new Error('Brave Search requires an API key.');
    const count = Math.min(Math.max(1, opts.count), 20); // Brave caps count at 20 per request.
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': creds.apiKey },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`);
    const data: any = await res.json();
    const results = data?.web?.results;
    if (!Array.isArray(results)) return [];
    return results
      .map(
        (r: any): WebSearchResult => ({
          title: String(r?.title || r?.url || 'Untitled'),
          url: String(r?.url || ''),
          snippet: String(r?.description || (Array.isArray(r?.extra_snippets) ? r.extra_snippets.join(' ') : '') || ''),
          source: 'brave',
        })
      )
      .filter((r: WebSearchResult) => !!r.url);
  },
};
