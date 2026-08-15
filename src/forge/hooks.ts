import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { logger } from '../util/logger';

export type HookEvent = 'session-start' | 'before-write' | 'after-write' | 'before-command' | 'after-command';

export interface HookResult {
  ran: boolean;
  blocked: boolean;
  message?: string;
}

const HOOK_TIMEOUT_MS = 10_000;

/**
 * Runs `.forge/hooks/<event>` (any executable script — shebang decides the
 * interpreter, e.g. `#!/usr/bin/env bash` or `#!/usr/bin/env node`) at agent
 * lifecycle points, Forge's equivalent of Cursor's `beforeSubmitPrompt` /
 * `afterFileEdit` / `beforeShellExecution` hooks. The event payload is
 * written to the script's stdin as JSON. For the two gating events
 * (`before-write`, `before-command`) a non-zero exit code blocks the action;
 * the script's stdout (if any) is shown to the user as the reason.
 */
export class HookRunner {
  constructor(private workspaceRoot: vscode.Uri) {}

  async run(event: HookEvent, payload: Record<string, any>): Promise<HookResult> {
    const hookUri = vscode.Uri.joinPath(this.workspaceRoot, '.forge', 'hooks', event);
    let exists = true;
    try {
      const stat = await vscode.workspace.fs.stat(hookUri);
      exists = !!stat;
    } catch {
      exists = false;
    }
    if (!exists) return { ran: false, blocked: false };

    return new Promise<HookResult>((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(hookUri.fsPath, {
          cwd: this.workspaceRoot.fsPath,
          shell: true,
          timeout: HOOK_TIMEOUT_MS,
          env: { ...process.env, FORGE_HOOK_EVENT: event },
        });
      } catch (err: any) {
        logger.warn(`Hook ${event} failed to start`, String(err));
        resolve({ ran: false, blocked: false });
        return;
      }

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        const blocked = (event === 'before-write' || event === 'before-command') && code !== 0;
        if (blocked) logger.info(`Hook ${event} blocked the action (exit ${code}): ${stdout || stderr}`);
        resolve({ ran: true, blocked, message: (stdout || stderr || '').trim().slice(0, 500) || undefined });
      };
      child.on('close', finish);
      child.on('error', (err: any) => {
        logger.warn(`Hook ${event} errored`, String(err));
        if (!settled) {
          settled = true;
          resolve({ ran: true, blocked: false });
        }
      });
    });
  }
}
