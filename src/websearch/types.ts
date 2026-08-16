/**
 * Web search (item "a terrific web search tool... for all types of internet
 * use cases"). This is deliberately the one feature in Forge that reaches
 * the open internet — everything else in this extension is local-only by
 * design (see README's "no cloud, no telemetry" tagline). Web search cannot
 * honor that promise by its nature: a query has to leave your machine to
 * search the web, and fetched pages come from third-party servers. That's
 * why it's opt-in (forge.webSearch.enabled defaults to false) rather than
 * on-by-default like every other tool — see modes.ts/config.ts for the gate.
 */

/** A single web search result, normalized across every provider. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Short excerpt/snippet from the provider — NOT full page content. Use web_fetch for that. */
  snippet: string;
  /** ISO date string if the provider supplied one (e.g. news results); undefined otherwise. */
  publishedAt?: string;
  /** Which provider this result came from — surfaced to the model so it can judge source diversity. */
  source: string;
}

export interface WebSearchOptions {
  /** How many results to request (providers may return fewer). Already clamped by the caller to forge.webSearch.maxResults. */
  count: number;
  /** AbortSignal for timeout/cancellation. */
  signal: AbortSignal;
}

/**
 * Whatever a provider needs to authenticate/target its backend. Not every
 * field applies to every provider — Brave/Tavily only use `apiKey`, Google
 * Custom Search needs `apiKey` + `cx` (the Programmable Search Engine id),
 * SearXNG needs `instanceUrl` instead of a key at all, DuckDuckGo needs
 * nothing. Each provider reads only the field(s) it needs.
 */
export interface ProviderCredentials {
  apiKey?: string;
  cx?: string;
  instanceUrl?: string;
}

/**
 * A pluggable search backend. Each provider wraps one real search API (or,
 * for DuckDuckGo, an HTML scrape used as the always-available, no-API-key
 * fallback — see duckduckgo.ts for why that one is inherently more fragile
 * than the others and should not be the primary choice when a real API key
 * is available).
 */
export interface SearchProvider {
  /** Stable id used in forge.webSearch.provider and cache keys. */
  id: string;
  /** Human-readable name for settings UI / error messages. */
  displayName: string;
  /** Whether this provider needs credentials configured (affects whether it's eligible for the 'auto' fallback chain and shown as "configured" in the Settings panel). */
  requiresApiKey: boolean;
  /** Whether the given credentials are sufficient to actually call this provider (e.g. Google needs both apiKey AND cx). */
  isConfigured(creds: ProviderCredentials): boolean;
  /** Runs a search. Should throw on failure (network error, non-2xx, malformed response) — the caller (searchService.ts) handles retry/fallback, this should not swallow errors. */
  search(query: string, creds: ProviderCredentials, opts: WebSearchOptions): Promise<WebSearchResult[]>;
}

/** Result of a web_fetch call — a specific page's extracted readable content. */
export interface WebFetchResult {
  ok: boolean;
  url: string;
  /** Final URL after following redirects, if different from the requested one. */
  finalUrl?: string;
  title?: string;
  /** Extracted plain text for the requested [offset, offset+length) window. */
  text: string;
  /** Total extracted text length, so the caller/model knows whether there's more to page through. */
  totalLength: number;
  offset: number;
  contentType?: string;
  /** Set when the fetch didn't produce text (blocked by robots.txt, non-HTML binary, HTTP error, timeout, etc.) — `text` is empty/explanatory in that case. */
  error?: string;
}
