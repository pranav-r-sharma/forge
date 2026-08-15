import { AgentEvent } from './types';
import { commandMatchesAutoApprove } from '../tools/commandTool';

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
    if (!this.getRequireApproval()) return Promise.resolve(true);
    if (commandMatchesAutoApprove(command, this.getAutoApprovePatterns())) return Promise.resolve(true);

    return new Promise((resolve) => {
      this.waiters.set(callId, resolve);
      this.emit({ type: 'approval_request', kind: 'command', callId, detail: command });
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
