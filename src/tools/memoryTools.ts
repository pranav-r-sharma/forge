import { ToolExecContext, ToolResult } from '../agent/types';

export async function rememberTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const fact: string = args.fact ?? args.text ?? '';
  if (!fact.trim()) return { ok: false, content: 'Missing required arg "fact".' };
  const result = await ctx.rememberFact(fact);
  if (!result.added) {
    return { ok: true, content: `Not added: ${result.reason || 'unknown reason'}` };
  }
  return { ok: true, content: `Remembered: "${fact.trim()}" — saved to .forge/memory.md and will be included in every future system prompt for this project.` };
}

export async function searchChatHistoryTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const query: string = args.query ?? '';
  if (!query) return { ok: false, content: 'Missing required arg "query".' };
  const k = clampK(args.k);

  const results = await ctx.chatMemorySearch(query, k);
  if (results.length === 0) {
    return { ok: true, content: `No relevant results found in past chat history for "${query}".` };
  }
  const body = results
    .map((r, i) => `[${i + 1}] from chat "${r.sessionTitle}" (score ${r.score.toFixed(2)})\n${r.snippet}`)
    .join('\n\n');
  return { ok: true, content: `Top ${results.length} relevant excerpt(s) from past chat history for "${query}":\n\n${body}` };
}

function clampK(raw: any): number {
  const n = raw ? Number(raw) : 6;
  return Math.max(1, Math.min(15, Number.isFinite(n) ? n : 6));
}
