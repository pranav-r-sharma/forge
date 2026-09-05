import { ToolExecContext, ToolResult } from '../agent/types';

/**
 * Thin tool wrapper around ToolExecContext.spawnSubAgent — the actual
 * recursive-runAgentTurn implementation lives as a closure in agentLoop.ts
 * (see MAX_SUBAGENT_DEPTH there), because spawning a nested agent turn needs
 * the same AgentDeps/model-resolution/cancellation machinery runAgentTurn
 * itself already has in scope; a standalone tool module has no access to
 * that. This file just adapts the ToolSpec shape the rest of tools/*.ts uses.
 */
export async function spawnSubAgentTool(args: Record<string, any>, ctx: ToolExecContext): Promise<ToolResult> {
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) {
    return { ok: false, content: 'spawn_subagent requires a non-empty "task" string describing exactly what the sub-agent should accomplish.' };
  }
  const contextHint = typeof args.context === 'string' ? args.context : undefined;
  // 0.14.0 resumeTaskId: pick up an existing "[~]"/"[!]" ledger entry
  // (see ToolExecContext.spawnSubAgent's doc comment) instead of always
  // creating a brand new one.
  const resumeTaskId = typeof args.resumeTaskId === 'string' && args.resumeTaskId.trim() ? args.resumeTaskId.trim() : undefined;
  const result = await ctx.spawnSubAgent(task, contextHint, resumeTaskId);
  return { ok: result.ok, content: result.summary };
}
