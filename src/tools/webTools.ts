import { ToolExecContext, ToolResult } from '../agent/types';

/** Formats a numbered, model-readable result list — plain text, not JSON, matching every other tool's `content` shape (see search_codebase/search_chat_history in searchTools.ts/memoryTools.ts). */
export async function webSearchTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  if (!ctx.webSearch) {
    return {
      ok: false,
      content: 'Web search is not enabled. Ask the user to turn on forge.webSearch.enabled (or the toggle in the Settings panel) — it defaults to off since it is the one Forge feature that sends data to the internet.',
    };
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, content: 'web_search requires a non-empty "query" string.' };

  const outcome = await ctx.webSearch(query);
  if (outcome.results.length === 0) {
    const reason = outcome.warnings.length ? ` (${outcome.warnings.join('; ')})` : '';
    return { ok: false, content: `No web search results for "${query}"${reason}.` };
  }

  const lines = outcome.results.map((r, i) => {
    const date = r.publishedAt ? ` [${r.publishedAt}]` : '';
    return `${i + 1}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`;
  });
  const header = `Web search results for "${query}" (via ${outcome.providerUsed || 'unknown provider'}):`;
  const warningNote = outcome.warnings.length ? `\n\n[Note: ${outcome.warnings.join('; ')}]` : '';
  return { ok: true, content: `${header}\n\n${lines.join('\n\n')}${warningNote}` };
}

export async function webFetchTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  if (!ctx.webFetch) {
    return {
      ok: false,
      content: 'Web search is not enabled. Ask the user to turn on forge.webSearch.enabled (or the toggle in the Settings panel) — it defaults to off since it is the one Forge feature that sends data to the internet.',
    };
  }
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) return { ok: false, content: 'web_fetch requires a non-empty "url" string — use a URL from a web_search result, or one the user gave you.' };
  const offset = typeof args.offset === 'number' && args.offset >= 0 ? Math.floor(args.offset) : 0;
  const length = typeof args.length === 'number' && args.length > 0 ? Math.floor(args.length) : undefined;

  const result = await ctx.webFetch(url, offset, length);
  if (!result.ok) {
    return { ok: false, content: `Could not fetch ${url}: ${result.error || 'unknown error'}` };
  }

  const remaining = result.totalLength - (result.offset + result.text.length);
  const pagingHint = remaining > 0 ? `\n\n[${remaining} more character(s) available — call web_fetch again with {"url": "${url}", "offset": ${result.offset + result.text.length}} to continue reading.]` : '';
  const redirectNote = result.finalUrl && result.finalUrl !== url ? `\n[Redirected to: ${result.finalUrl}]` : '';
  const titleLine = result.title ? `${result.title}\n${'='.repeat(Math.min(60, result.title.length))}\n` : '';
  return { ok: true, content: `${titleLine}${result.text}${redirectNote}${pagingHint}` };
}
