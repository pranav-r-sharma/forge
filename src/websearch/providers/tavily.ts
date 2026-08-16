import { ProviderCredentials, SearchProvider, WebSearchOptions, WebSearchResult } from '../types';

/**
 * Tavily Search API — POST https://api.tavily.com/search, `Authorization:
 * Bearer <key>`. Tavily is purpose-built for LLM/agent consumption (results
 * come pre-cleaned, and it can optionally include an LLM-generated answer),
 * which makes it a strong default when a key is configured. Verified
 * against Tavily's current API reference rather than assumed, since their
 * auth scheme changed from an `api_key` body field to a Bearer header at
 * some point and getting that wrong would silently 401 every request.
 */
export const tavilyProvider: SearchProvider = {
  id: 'tavily',
  displayName: 'Tavily',
  requiresApiKey: true,
  isConfigured: (creds) => !!creds.apiKey,
  async search(query: string, creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]> {
    if (!creds.apiKey) throw new Error('Tavily requires an API key.');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({
        query,
        max_results: Math.min(Math.max(1, opts.count), 20),
        search_depth: 'basic',
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
    const data: any = await res.json();
    const results = data?.results;
    if (!Array.isArray(results)) return [];
    return results
      .map(
        (r: any): WebSearchResult => ({
          title: String(r?.title || r?.url || 'Untitled'),
          url: String(r?.url || ''),
          snippet: String(r?.content || ''),
          source: 'tavily',
        })
      )
      .filter((r: WebSearchResult) => !!r.url);
  },
};
