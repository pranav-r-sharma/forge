import { AgentEvent } from './types';
import { commandMatchesAutoApprove, isDangerousCommand } from '../tools/commandTool';

/**
 * Bridges the agent loop's `run_command` tool with the chat webview: a
 * command that isn't auto-approved blocks the loop until the user clicks
 * Approve/Deny, which arrives asynchronously as a webview message and is
 * routed here via `resolve()`.
 */
export class ApprovalBroker {
  private waiters = new Map<string, (approved: boolean) => void>();

  constructor(
    private emit: (event: AgentEvent) => void,
    private getAutoApprovePatterns: () => string[],
    private getRequireApproval: () => boolean
  ) {}

  requestCommandApproval(command: string, callId: string): Promise<boolean> {
    // The dangerous-command denylist always wins, even when requireApproval
    // is off (Auto mode) — see commandTool.ts for why.
    if (!isDangerousCommand(command)) {
      if (!this.getRequireApproval()) return Promise.resolve(true);
      if (commandMatchesAutoApprove(command, this.getAutoApprovePatterns())) return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      this.waiters.set(callId, resolve);
      this.emit({
        type: 'approval_request',
        kind: 'command',
        callId,
        detail: isDangerousCommand(command) ? `${command}\n\n⚠ This command matches Forge's hard-coded dangerous-command list and always requires your approval, even in Auto mode.` : command,
      });
    });
  }

  /**
   * Cost-aware task planning's blocking review gate (see
   * agent/types.ts's ToolExecContext.requestPlanApproval doc comment) — no
   * auto-approve bypass here, unlike requestCommandApproval: the caller
   * (tools/taskLedgerTools.ts's planTasksTool) already decided this is worth
   * asking about before ever calling this, so it always waits for a real
   * answer. Shares the same `waiters` map/resolve()/cancelAll() plumbing as
   * command approval — a "plan review" is just a different `kind` of the
   * same underlying "block the loop until the webview answers" mechanism.
   */
  requestPlanApproval(detail: string, callId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiters.set(callId, resolve);
      this.emit({ type: 'approval_request', kind: 'plan_review', callId, detail });
    });
  }

  resolve(callId: string, approved: boolean) {
    const fn = this.waiters.get(callId);
    if (fn) {
      fn(approved);
      this.waiters.delete(callId);
    }
  }

  cancelAll() {
    for (const fn of this.waiters.values()) fn(false);
    this.waiters.clear();
  }
}
