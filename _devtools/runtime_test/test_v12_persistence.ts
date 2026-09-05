// Runtime tests for the 0.12.0 "checkpoint progress, don't redo work after an
// interruption" round's core fix: agentLoop.ts's new 'history_snapshot'
// AgentEvent (see agent/types.ts's doc comment on it for the full root-cause
// writeup). Before this, ChatSession only learned a turn's updated
// modelHistory once runAgentTurn() fully RETURNED — a mid-turn crash left the
// next turn resuming from the PREVIOUS turn's Ollama-facing history, even
// though the UI transcript (uiHistory) was already persisted incrementally.
// This file tests the mechanism at the agentLoop.ts level (where the actual
// logic lives — pushMsg()'s wrapping of every `messages` mutation);
// ChatSession.handleAgentEvent()'s 'history_snapshot' case is a 3-line
// direct consumer of this event (this.modelHistory = event.messages;
// this.persist();), verified by typecheck and by the fact that every other
// UI-facing AgentEvent case in that same switch already follows the
// identical "apply then persist" pattern (see e.g. 'tool_result').
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentTurn } from '../../src/agent/agentLoop';
import { ApprovalBroker } from '../../src/agent/approvalBroker';
import { PendingEditManager } from '../../src/tools/editApply';
import { HookRunner } from '../../src/forge/hooks';
import { AgentEvent } from '../../src/agent/types';
import { ChatMessage } from '../../src/ollama/types';

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`ok - ${label}`);
  } else {
    failed++;
    console.error(`NOT OK - ${label}`);
  }
}

function freshWorkspace(): vscode.Uri {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-v12-persist-test-'));
  return vscode.Uri.file(tmp);
}

function baseDeps(workspaceRoot: vscode.Uri, events: AgentEvent[], fakeOllama: any) {
  return {
    ollama: fakeOllama,
    pendingEdits: new PendingEditManager(workspaceRoot),
    approvalBroker: new ApprovalBroker((e: AgentEvent) => events.push(e), () => [], () => false),
    hooks: new HookRunner(workspaceRoot),
    codebaseSearch: async () => [],
    rememberFact: async () => ({ added: false }),
    chatMemorySearch: async () => [],
    backgroundProcesses: { start: async () => ({}), check: async () => ({}), kill: async () => ({}), list: () => [] },
    mcpTools: [],
    workspaceRoot,
    workspaceName: 'test',
  };
}

async function main() {
  // ---------- a snapshot fires for every model-facing transcript mutation, in order ----------
  {
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) return '```forge_action\n{"tool": "list_dir", "args": {"path": "."}}\n```';
        return 'All done.';
      },
    };
    const deps: any = baseDeps(workspaceRoot, events, fakeOllama);
    const cts = new vscode.CancellationTokenSource();
    const result = await runAgentTurn([], 'list the root directory', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });

    const snapshots = events.filter((e): e is Extract<AgentEvent, { type: 'history_snapshot' }> => e.type === 'history_snapshot');
    // Expected mutations for a one-tool-then-final turn: (1) the turn's own
    // user message, (2) the assistant message choosing the tool, (3) the
    // tool's result fed back, (4) the final assistant answer. Order matters
    // as much as count — this is the transcript Ollama will actually see.
    ok(snapshots.length === 4, `exactly 4 history_snapshot events fire for a one-tool-then-final turn (got ${snapshots.length})`);
    ok(snapshots.every((s, i) => i === 0 || s.messages.length === snapshots[i - 1].messages.length + 1), 'each snapshot is exactly one message longer than the previous one — nothing is skipped or double-applied');
    ok(snapshots[0].messages[snapshots[0].messages.length - 1].role === 'user', 'the first snapshot ends with the turn\'s own user message');
    ok(snapshots[1].messages[snapshots[1].messages.length - 1].role === 'assistant', 'the second snapshot (after the model chose a tool) ends with that assistant message');
    ok(/list_dir/.test(JSON.stringify(snapshots[1].messages[snapshots[1].messages.length - 1])), 'that assistant message actually contains the tool call the model made');
    ok(/Tool "list_dir" result/.test(String(snapshots[2].messages[snapshots[2].messages.length - 1].content)), 'the third snapshot carries the real tool result content, not a placeholder');
    ok(snapshots[3].messages[snapshots[3].messages.length - 1].role === 'assistant' && /All done/.test(String(snapshots[3].messages[snapshots[3].messages.length - 1].content)), 'the fourth (final) snapshot carries the model\'s actual final answer');

    // The whole point: if a host crash happened right after snapshot[2] (the
    // tool result), a fresh agent resuming from snapshots[2].messages would
    // already see that the directory was listed and its result — it would
    // NOT need to redundantly re-run list_dir to find out what's already
    // known. That's exactly the state result.messages ends up in too.
    ok(JSON.stringify(result.messages) === JSON.stringify(snapshots[snapshots.length - 1].messages), 'the turn\'s final returned messages array is byte-identical to the last emitted snapshot — no drift between incremental persistence and the authoritative end-of-turn state');
  }

  // ---------- a snapshot still fires (with the tool error folded in) when a tool call fails ----------
  {
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) return '```forge_action\n{"tool": "not_a_real_tool", "args": {}}\n```';
        return 'Recovered after the tool error.';
      },
    };
    const deps: any = baseDeps(workspaceRoot, events, fakeOllama);
    const cts = new vscode.CancellationTokenSource();
    await runAgentTurn([], 'try something invalid', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });
    const snapshots = events.filter((e): e is Extract<AgentEvent, { type: 'history_snapshot' }> => e.type === 'history_snapshot');
    ok(snapshots.some((s) => /Unknown tool/.test(String(s.messages[s.messages.length - 1].content))), 'an unknown-tool error is itself captured in a history_snapshot, so a resumed turn knows that path was already tried and failed rather than retrying it blind');
  }

  // ---------- cancellation mid-turn: whatever was snapshotted right before the abort is exactly what's recoverable ----------
  {
    const workspaceRoot = freshWorkspace();
    const events: AgentEvent[] = [];
    const cts = new vscode.CancellationTokenSource();
    let call = 0;
    const fakeOllama: any = {
      chat: async () => {
        call++;
        if (call === 1) {
          cts.cancel(); // simulate the user hitting Stop right after the model picks a tool, before the tool result lands
          return '```forge_action\n{"tool": "list_dir", "args": {"path": "."}}\n```';
        }
        return 'unreachable';
      },
    };
    const deps: any = baseDeps(workspaceRoot, events, fakeOllama);
    const result = await runAgentTurn([], 'do something', deps, (e) => events.push(e), cts.token, 'fake-model', { mode: 'agent' });
    const snapshots = events.filter((e): e is Extract<AgentEvent, { type: 'history_snapshot' }> => e.type === 'history_snapshot');
    ok(events.some((e) => e.type === 'aborted'), 'the turn reports aborted after cancellation');
    ok(snapshots.length >= 1, 'at least the pre-cancellation history was snapshotted, not lost entirely');
    ok(JSON.stringify(result.messages) === JSON.stringify(snapshots[snapshots.length - 1].messages), 'even on an aborted turn, the returned messages exactly match the last snapshot — a resumed session picks up from real, already-persisted state, not a gap');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
  console.log('All v0.12.0 incremental-persistence runtime tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
