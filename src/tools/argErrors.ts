/** Human-readable label for wrong-type tool-arg errors. */
export function receivedTypeLabel(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return `a ${t}`;
  return t;
}

/** Suggest a shell command string when the model sent argv-style arrays. */
export function suggestCommandFromArgvArray(value: unknown[]): string {
  if (
    value.length >= 3 &&
    (value[0] === 'bash' || value[0] === 'sh') &&
    (value[1] === '-lc' || value[1] === '-c')
  ) {
    return String(value[value.length - 1]);
  }
  return value.map((x) => String(x)).join(' ');
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
