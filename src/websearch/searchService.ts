import { ProviderCredentials, SearchProvider, WebSearchResult } from './types';
import { braveProvider } from './providers/brave';
import { tavilyProvider } from './providers/tavily';
import { googleCseProvider } from './providers/googleCse';
import { searxngProvider } from './providers/searxng';
import { duckduckgoProvider } from './providers/duckduckgo';
import { logger } from '../util/logger';

/** Registry of every known provider, in the priority order 'auto' tries them — real, higher-quality APIs first, the always-available scrape fallback last. */
export const PROVIDERS: SearchProvider[] = [tavilyProvider, braveProvider, googleCseProvider, searxngProvider, duckduckgoProvider];
export const PROVIDER_MAP: Record<string, SearchProvider> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

export interface WebSearchServiceConfig {
  provider: string; // 'auto' or a PROVIDERS[].id
  maxResults: number;
  timeoutMs: number;
  cacheTtlMinutes: number;
  blockedDomains: string[];
}

export interface WebSearchOutcome {
  results: WebSearchResult[];
  providerUsed?: string;
  /** Non-fatal issues worth telling the model about even on success — e.g. a configured provider failed and Forge fell through to the next one. */
  warnings: string[];
}

interface CacheEntry {
  expiresAt: number;
  outcome: WebSearchOutcome;
}

/**
 * Orchestrates search across the configured provider(s): resolves which
 * provider(s) to try (an explicit choice, or the 'auto' fallback chain),
 * retries each once on failure before falling through to the next, caches
 * results briefly to avoid hammering a provider (or burning paid-API quota)
 * on repeated/looping queries within a session, de-duplicates results by
 * normalized URL, and drops anything matching the configured domain
 * blocklist. This is the single entry point web_search's tool wrapper calls
 * — see tools/webSearchTool.ts.
 */
export class WebSearchService {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private getConfig: () => WebSearchServiceConfig,
    /** Resolves stored credentials for a provider id — backed by vscode.SecretStorage, see keyStore.ts. Async because SecretStorage reads are async. */
    private getCredentials: (providerId: string) => Promise<ProviderCredentials>
  ) {}

  async search(query: string): Promise<WebSearchOutcome> {
    const cfg = this.getConfig();
    const q = query.trim();
    if (!q) return { results: [], warnings: ['Empty query.'] };

    const chain = await this.resolveChain(cfg.provider);
    if (chain.length === 0) {
      return {
        results: [],
        warnings: ['No web search provider is usable — the DuckDuckGo fallback should always be available; this likely means forge.webSearch.provider is set to an unknown id.'],
      };
    }

    const count = Math.max(1, Math.min(cfg.maxResults, 20));
    const cacheKey = `${chain[0].id}:${normalizeQuery(q)}:${count}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > timeNow()) return cached.outcome;

    const warnings: string[] = [];
    for (const provider of chain) {
      const creds = await this.getCredentials(provider.id);
      if (provider.requiresApiKey && !provider.isConfigured(creds)) continue;
      try {
        const raw = await this.callWithRetry(provider, q, creds, count);
        const filtered = dedupeAndFilter(raw, cfg.blockedDomains);
        const outcome: WebSearchOutcome = { results: filtered, providerUsed: provider.id, warnings };
        this.cache.set(cacheKey, { expiresAt: timeNow() + Math.max(0, cfg.cacheTtlMinutes) * 60_000, outcome });
        return outcome;
      } catch (err: any) {
        const msg = `${provider.displayName} failed: ${err?.message || err}`;
        logger.warn('web search provider failed', msg);
        warnings.push(msg);
      }
    }

    return { results: [], warnings: [...warnings, 'Every eligible provider failed — see warnings above.'] };
  }

  /** Which providers to actually try, in order — an explicit id (if configured/eligible), else the full 'auto' priority chain filtered to providers that are actually usable right now. */
  private async resolveChain(providerSetting: string): Promise<SearchProvider[]> {
    if (providerSetting && providerSetting !== 'auto') {
      const p = PROVIDER_MAP[providerSetting];
      return p ? [p] : [];
    }
    const usable: SearchProvider[] = [];
    for (const p of PROVIDERS) {
      if (!p.requiresApiKey) {
        usable.push(p);
        continue;
      }
      const creds = await this.getCredentials(p.id);
      if (p.isConfigured(creds)) usable.push(p);
    }
    // DuckDuckGo never requires credentials, so it's always eligible and
    // always last in PROVIDERS — the chain is never empty in 'auto' mode.
    return usable;
  }

  private async callWithRetry(provider: SearchProvider, query: string, creds: ProviderCredentials, count: number): Promise<WebSearchResult[]> {
    const cfg = this.getConfig();
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
      try {
        return await provider.search(query, creds, { count, signal: controller.signal });
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await sleep(300);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Test/debug hook — not used in normal operation. */
  clearCache() {
    this.cache.clear();
  }
}

function dedupeAndFilter(results: WebSearchResult[], blockedDomains: string[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const r of results) {
    let host: string;
    try {
      host = new URL(r.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      continue; // an unparseable URL is not useful to the model anyway
    }
    if (blockedDomains.some((blocked) => host === blocked.toLowerCase().replace(/^www\./, '') || host.endsWith(`.${blocked.toLowerCase().replace(/^www\./, '')}`))) {
      continue;
    }
    const key = `${host}${new URL(r.url).pathname}`.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Isolated so tests can't be affected by the workflow-script Date.now() ban
// elsewhere in this codebase's tooling — this file runs in the real
// extension host / ts-node, where Date.now() is completely normal.
function timeNow(): number {
  return Date.now();
}
