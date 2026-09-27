import { ToolExecContext, ToolResult } from '../agent/types';
import { requireStringArg } from './argErrors';

export async function rememberTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const factCheck = requireStringArg('remember', 'fact', args.fact ?? args.text, 'Missing required arg "fact".');
  if (!factCheck.ok) return { ok: false, content: factCheck.content };
  const fact = factCheck.value;
  const result = await ctx.rememberFact(fact);
  if (!result.added) {
    return { ok: true, content: `Not added: ${result.reason || 'unknown reason'}` };
  }
  return { ok: true, content: `Remembered: "${fact.trim()}" — saved to .forge/memory.md and will be included in every future system prompt for this project.` };
}

export async function searchChatHistoryTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const queryCheck = requireStringArg('search_chat_history', 'query', args.query, 'Missing required arg "query".');
  if (!queryCheck.ok) return { ok: false, content: queryCheck.content };
  const query = queryCheck.value;
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
