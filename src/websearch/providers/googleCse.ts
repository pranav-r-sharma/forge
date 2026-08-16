import { ProviderCredentials, SearchProvider, WebSearchOptions, WebSearchResult } from '../types';

/**
 * Google Programmable Search Engine (Custom Search JSON API) —
 * https://www.googleapis.com/customsearch/v1. Needs BOTH an API key and a
 * Search Engine ID (`cx`) — a Custom Search Engine has to be created at
 * programmablesearchengine.google.com first and configured to search the
 * whole web, which is more setup than the other providers but is a real
 * Google-quality index once configured. Free tier is 100 queries/day.
 */
export const googleCseProvider: SearchProvider = {
  id: 'google',
  displayName: 'Google Programmable Search',
  requiresApiKey: true,
  isConfigured: (creds) => !!creds.apiKey && !!creds.cx,
  async search(query: string, creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]> {
    if (!creds.apiKey || !creds.cx) throw new Error('Google Programmable Search requires both an API key and a Search Engine ID (cx).');
    // The API returns at most 10 results per request (`num` is capped at 10);
    // a "count" beyond that would need paging via `start`, which isn't worth
    // the extra round-trips for a single agent tool call — 10 is already
    // Forge's typical forge.webSearch.maxResults ceiling anyway.
    const num = Math.min(Math.max(1, opts.count), 10);
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(creds.apiKey)}&cx=${encodeURIComponent(creds.cx)}&q=${encodeURIComponent(query)}&num=${num}`;
    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) throw new Error(`Google Programmable Search HTTP ${res.status}`);
    const data: any = await res.json();
    const items = data?.items;
    if (!Array.isArray(items)) return [];
    return items
      .map(
        (r: any): WebSearchResult => ({
          title: String(r?.title || r?.link || 'Untitled'),
          url: String(r?.link || ''),
          snippet: String(r?.snippet || ''),
          source: 'google',
        })
      )
      .filter((r: WebSearchResult) => !!r.url);
  },
};
