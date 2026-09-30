/** Human-readable label for wrong-type tool-arg errors. */
export function receivedTypeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return `a ${t}`;
  return t;
}

/** Shell-join argv tokens for run_command when the model sends an array. */
export function shellQuoteJoinArgv(value: unknown[]): string {
  if (
    value.length >= 3 &&
    (value[0] === 'bash' || value[0] === 'sh') &&
    (value[1] === '-lc' || value[1] === '-c')
  ) {
    return String(value[value.length - 1]);
  }
  return value
    .map((x) => {
      const s = String(x);
      if (/^[A-Za-z0-9_./=-]+$/.test(s)) return s;
      return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join(' ');
}

/** Suggest a shell command string when the model sent argv-style arrays. */
export function suggestCommandFromArgvArray(value: unknown[]): string {
  return shellQuoteJoinArgv(value);
}

/** Resolve run_command's command field (string or argv array). */
export function resolveRunCommandString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0) return shellQuoteJoinArgv(value);
  return undefined;
}

export function formatWrongTypeResend(
  tool: string,
  argName: string,
  expectedType: string,
  received: unknown,
  suggestedScalar?: string,
): string {
  const recv = receivedTypeLabel(received);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (suggestedScalar !== undefined) {
    return `Arg "${argName}" must be a ${expectedType}, but you sent ${recv}. Resend as {"tool":"${tool}","args":{"${argName}":"${esc(suggestedScalar)}"}}`;
  }
  return `Arg "${argName}" must be a ${expectedType}, but you sent ${recv}. Resend with "${argName}" as a ${expectedType}.`;
}

export type RequiredStringResult =
  | { ok: true; value: string }
  | { ok: false; content: string };

/**
 * Validates a required string tool arg. Wrong types get a precise resend hint;
 * missing/empty uses `missingMessage` verbatim.
 */
export function requireStringArg(
  tool: string,
  argName: string,
  value: unknown,
  missingMessage: string,
  suggestWrongType?: (wrong: unknown) => string | undefined,
): RequiredStringResult {
  if (value === undefined || value === null) {
    return { ok: false, content: missingMessage };
  }
  if (typeof value !== 'string') {
    const suggested = suggestWrongType?.(value);
    return {
      ok: false,
      content: formatWrongTypeResend(tool, argName, 'string', value, suggested),
    };
  }
  if (!value.trim()) {
    return { ok: false, content: missingMessage };
  }
  return { ok: true, value };
}

/** Args object that embeds a full `{tool, args}` action instead of real tool fields. */
export function detectNestedToolAction(args: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | undefined {
  if (typeof args.tool !== 'string' || !args.tool.trim()) return undefined;
  const inner = args.args;
  if (inner === undefined || inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  return { tool: args.tool.trim(), args: inner as Record<string, unknown> };
}

export function formatNestedActionResend(_outerTool: string, inner: { tool: string; args: Record<string, unknown> }): string {
  const payload = JSON.stringify({ tool: inner.tool, args: inner.args });
  return `You nested a whole action inside "args". Resend as ${payload}`;
}

/** Unwrap {"tool","args"} accidentally nested inside another tool's args. */
export function unwrapNestedToolCall<T extends { tool: string; args: Record<string, unknown> }>(call: T): T {
  const nested = detectNestedToolAction(call.args);
  if (!nested) return call;
  return { ...call, tool: nested.tool, args: nested.args };
}
