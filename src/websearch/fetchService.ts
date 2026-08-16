import { extractReadablePage } from './htmlExtract';
import { ALLOW_ALL, isPathAllowed, parseRobotsTxt, RobotsRules } from './robotsTxt';
import { WebFetchResult } from './types';
import { logger } from '../util/logger';

const FORGE_USER_AGENT = 'Mozilla/5.0 (compatible; ForgeAgent/1.0; +local-vscode-extension)';
const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000; // robots.txt changes rarely — cache per-origin for an hour regardless of the page-cache TTL setting.
const DEFAULT_PAGE_LENGTH = 8000; // characters per web_fetch call when the model doesn't specify one — mirrors read_file's line-range paging philosophy for a source that has no natural "lines".

export interface WebFetchServiceConfig {
  timeoutMs: number;
  respectRobotsTxt: boolean;
  /** Caps how much of the raw response body is read before extraction — an approximate, character-based cap (not a true byte-stream cutoff) applied to the decoded text, which is a deliberate simplification to avoid needing a streaming-with-early-abort implementation for what is, in practice, rarely hit (most articles/docs pages are well under this). */
  maxFetchChars: number;
  cacheTtlMinutes: number;
}

interface CachedPage {
  expiresAt: number;
  title?: string;
  text: string;
  contentType?: string;
  finalUrl: string;
}

/**
 * Backs the web_fetch tool: downloads a specific URL, respects robots.txt by
 * default, extracts readable text (see htmlExtract.ts), and returns it in a
 * paged window so a long article doesn't blow the model's context in one
 * shot — call again with a larger `offset` to keep reading, the same
 * pattern read_file already uses for line ranges.
 */
export class WebFetchService {
  private pageCache = new Map<string, CachedPage>();
  private robotsCache = new Map<string, { expiresAt: number; rules: RobotsRules }>();

  constructor(private getConfig: () => WebFetchServiceConfig) {}

  async fetch(rawUrl: string, offset = 0, length?: number): Promise<WebFetchResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, url: rawUrl, text: '', totalLength: 0, offset: 0, error: `"${rawUrl}" is not a valid URL.` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, url: rawUrl, text: '', totalLength: 0, offset: 0, error: `Unsupported URL scheme "${url.protocol}" — only http/https are fetchable.` };
    }

    const cfg = this.getConfig();
    const cacheKey = url.toString();
    let cached = this.pageCache.get(cacheKey);
    if (!cached || cached.expiresAt <= Date.now()) {
      const fresh = await this.fetchAndExtract(url, cfg);
      if (!fresh.ok) return fresh;
      cached = { expiresAt: Date.now() + Math.max(0, cfg.cacheTtlMinutes) * 60_000, title: fresh.title, text: fresh.text, contentType: fresh.contentType, finalUrl: fresh.finalUrl || cacheKey };
      this.pageCache.set(cacheKey, cached);
    }

    const start = Math.max(0, offset);
    const len = length && length > 0 ? length : DEFAULT_PAGE_LENGTH;
    return {
      ok: true,
      url: rawUrl,
      finalUrl: cached.finalUrl !== rawUrl ? cached.finalUrl : undefined,
      title: cached.title,
      text: cached.text.slice(start, start + len),
      totalLength: cached.text.length,
      offset: start,
      contentType: cached.contentType,
    };
  }

  private async fetchAndExtract(url: URL, cfg: WebFetchServiceConfig): Promise<WebFetchResult> {
    if (cfg.respectRobotsTxt) {
      const allowed = await this.checkRobots(url);
      if (!allowed) {
        return {
          ok: false,
          url: url.toString(),
          text: '',
          totalLength: 0,
          offset: 0,
          error: `Blocked by ${url.origin}/robots.txt (disallows ${url.pathname}). Set forge.webSearch.respectRobotsTxt to false to override, if you're sure that's appropriate here.`,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, cfg.timeoutMs));
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { 'User-Agent': FORGE_USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      return { ok: false, url: url.toString(), text: '', totalLength: 0, offset: 0, error: timedOut ? `Timed out after ${cfg.timeoutMs}ms.` : `Fetch failed: ${err?.message || err}` };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { ok: false, url: url.toString(), text: '', totalLength: 0, offset: 0, error: `HTTP ${res.status} ${res.statusText}` };
    }

    const finalUrl = res.url || url.toString();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('application/pdf')) {
      return {
        ok: false,
        url: url.toString(),
        finalUrl,
        text: '',
        totalLength: 0,
        offset: 0,
        contentType,
        error: 'This URL is a PDF. Forge extracts text from HTML pages but does not parse PDFs (no PDF-parsing dependency is bundled — see the zero-runtime-dependency note in README). Try a different source, or ask the user to share the relevant excerpt directly.',
      };
    }
    if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('xml')) {
      return {
        ok: false,
        url: url.toString(),
        finalUrl,
        text: '',
        totalLength: 0,
        offset: 0,
        contentType,
        error: `Unsupported content type "${contentType || 'unknown'}" — web_fetch only reads text/HTML/JSON pages, not binary files.`,
      };
    }

    let raw: string;
    try {
      raw = await res.text();
    } catch (err: any) {
      return { ok: false, url: url.toString(), finalUrl, text: '', totalLength: 0, offset: 0, error: `Failed to read response body: ${err?.message || err}` };
    }
    if (raw.length > cfg.maxFetchChars) raw = raw.slice(0, cfg.maxFetchChars);

    if (contentType.includes('text/html') || contentType.includes('xml')) {
      const { title, text } = extractReadablePage(raw);
      return { ok: true, url: url.toString(), finalUrl, title, text, totalLength: text.length, offset: 0, contentType };
    }
    // Plain text / JSON — return as-is, no HTML extraction needed.
    return { ok: true, url: url.toString(), finalUrl, text: raw.trim(), totalLength: raw.trim().length, offset: 0, contentType };
  }

  private async checkRobots(url: URL): Promise<boolean> {
    const cached = this.robotsCache.get(url.origin);
    let rules: RobotsRules;
    if (cached && cached.expiresAt > Date.now()) {
      rules = cached.rules;
    } else {
      rules = await this.fetchRobots(url.origin);
      this.robotsCache.set(url.origin, { expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS, rules });
    }
    return isPathAllowed(rules, url.pathname + url.search);
  }

  private async fetchRobots(origin: string): Promise<RobotsRules> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': FORGE_USER_AGENT }, signal: controller.signal });
      if (!res.ok) return ALLOW_ALL; // no robots.txt (404 etc.) = everything allowed, per RFC 9309's own default.
      const text = await res.text();
      return parseRobotsTxt(text, 'ForgeAgent');
    } catch (err) {
      logger.warn('robots.txt fetch failed, treating as allow-all', String(err));
      return ALLOW_ALL; // fail-open: a network hiccup fetching robots.txt should never block a legitimate fetch.
    } finally {
      clearTimeout(timer);
    }
  }
}
