import { UiTranscriptEntry } from '../webview/protocol';
import { CheckpointRecord } from '../agent/checkpoints';

/**
 * Milestone digests (item "documenting all milestones, logging checkpoints
 * so context can be derived from that"): a short, MECHANICALLY-generated
 * (no LLM call, no network, can't fail or hallucinate) one-line summary of
 * what a single turn actually did, derived straight from its transcript
 * entries. Attached to that turn's checkpoint (see checkpoints.ts) the
 * moment the turn finishes.
 *
 * This is deliberately a different, complementary mechanism from
 * contextManager.ts's compaction summary: compaction is an LLM call, made
 * lazily only once a session's live prompt actually needs shrinking, and is
 * inherently lossy/interpretive. A milestone costs nothing (pure string
 * work over data already in memory), exists for every turn from the moment
 * it completes, and is exact rather than interpreted — a durable, always-
 * available table of contents a long session's context can be reconstructed
 * from, rather than relying solely on what a summarization pass chose to
 * keep. The two are meant to be read together: milestonesText below is
 * injected into the system prompt so the model itself can see the shape of
 * the whole session at a glance, even the parts compaction has since folded
 * away.
 */
export function deriveMilestoneSummary(turnEntries: UiTranscriptEntry[]): string {
  const filesWritten = new Set<string>();
  const filesDeleted = new Set<string>();
  const commandsRun: string[] = [];
  const toolCounts = new Map<string, number>();
  let toolFailures = 0;
  let subAgentCount = 0;
  let verifyOutcome: 'passed' | 'failed' | undefined;
  let hadError = false;
  let finalTextLen = 0;

  for (const e of turnEntries) {
    switch (e.kind) {
      case 'tool': {
        toolCounts.set(e.tool, (toolCounts.get(e.tool) || 0) + 1);
        if (e.status === 'done' && e.ok === false) toolFailures++;
        if (e.tool === 'write_file' && e.status === 'done') {
          const path = typeof e.args?.path === 'string' ? e.args.path : undefined;
          if (path) {
            if (e.args?.delete) filesDeleted.add(path);
            else filesWritten.add(path);
          }
        }
        if (e.tool === 'run_command' && typeof e.args?.command === 'string') {
          commandsRun.push(e.args.command);
        }
        break;
      }
      case 'subagent':
        subAgentCount++;
        break;
      case 'verify':
        if (e.status === 'done') verifyOutcome = e.ok ? 'passed' : 'failed';
        break;
      case 'error':
        hadError = true;
        break;
      case 'assistant':
        finalTextLen = e.text.length;
        break;
    }
  }

  const parts: string[] = [];
  if (filesWritten.size) parts.push(`edited ${summarizeFileList([...filesWritten])}`);
  if (filesDeleted.size) parts.push(`deleted ${summarizeFileList([...filesDeleted])}`);
  if (commandsRun.length) parts.push(`ran ${commandsRun.length === 1 ? `\`${truncate(commandsRun[0], 60)}\`` : `${commandsRun.length} command(s)`}`);
  if (subAgentCount) parts.push(`delegated to ${subAgentCount} sub-agent${subAgentCount === 1 ? '' : 's'}`);
  const otherTools = [...toolCounts.entries()].filter(([name]) => name !== 'write_file' && name !== 'run_command');
  if (otherTools.length && parts.length < 2) {
    parts.push(`used ${otherTools.map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(', ')}`);
  }
  if (verifyOutcome) parts.push(`definition-of-done ${verifyOutcome}`);
  if (toolFailures) parts.push(`${toolFailures} tool call(s) failed`);
  if (hadError) parts.push('turn ended in an error');

  if (parts.length === 0) {
    return finalTextLen > 0 ? 'Answered directly, no tools used.' : 'No visible action taken.';
  }
  return capitalize(parts.join('; ')) + '.';
}

function summarizeFileList(paths: string[]): string {
  if (paths.length <= 3) return paths.join(', ');
  return `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more file(s)`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const MAX_MILESTONES_IN_PROMPT = 30;
const MAX_PROMPT_CHARS = 3000;

/**
 * Renders every checkpoint's milestone into a compact block for the system
 * prompt — the "context can be derived from that" half of this feature.
 * Capped on both count and total characters (oldest dropped first) so a
 * very long session's milestone log can't itself become a context problem;
 * the full, uncapped list is always still visible in the UI (checkpoint
 * hover) and on disk regardless of what's trimmed here.
 */
export function renderMilestonesForPrompt(checkpoints: CheckpointRecord[]): string | undefined {
  const withMilestones = checkpoints.filter((c) => !!c.milestone);
  if (withMilestones.length === 0) return undefined;
  const recent = withMilestones.slice(-MAX_MILESTONES_IN_PROMPT);
  const lines = recent.map((c, i) => `${i + 1}. [${c.label}] ${c.milestone}`);
  let text = lines.join('\n');
  if (text.length > MAX_PROMPT_CHARS) {
    // Drop oldest lines until it fits — recent milestones matter most for "what's the current state."
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const next = lines[i].length + 1;
      if (total + next > MAX_PROMPT_CHARS) break;
      kept.unshift(lines[i]);
      total += next;
    }
    text = kept.join('\n');
  }
  return `## Milestones so far this session (mechanically logged, not a summary — each line is one prior turn)\n${text}`;
}
