import { ToolCall } from './types';

/**
 * Optional alternative to the fenced-```forge_action``` text contract
 * (toolProtocol.ts), gated behind `forge.structuredOutput.enabled` (off by
 * default). Ollama supports constrained/grammar-guided decoding via a
 * `format` request field (a JSON Schema, or the string `"json"`) — when the
 * server and model actually honor it, this eliminates a whole class of bug
 * ("malformed tool-call JSON that the defensive parser recovers into the
 * wrong shape") by construction, rather than trying to parse around it after
 * the fact.
 *
 * Why this is opt-in rather than the default: this sandbox has no way to run
 * a real Ollama server to verify how well `format`-constrained decoding
 * actually behaves with the small local coder models Forge targets (does it
 * meaningfully hurt reasoning quality by forcing JSON on every turn, does
 * every model version actually respect it, does it add latency). The
 * mechanism here is real and does something (see agentLoop.ts's wiring) —
 * whether it's a net win for YOUR model is exactly the kind of thing that
 * needs testing against a live server, which is why this ships as a toggle
 * you can try and turn back off, not a silent replacement for the existing,
 * battle-tested defensive parser.
 *
 * The schema below is intentionally a single flat envelope rather than a
 * JSON-Schema `oneOf` of two shapes: Ollama's structured-output support
 * targets plain object schemas most reliably, and a discriminated
 * `response_type` field is simple for a small model to get right and simple
 * to validate here without a JSON-Schema library (this project has zero
 * runtime npm dependencies — see README).
 */
export const STRUCTURED_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    response_type: { type: 'string', enum: ['final_answer', 'tool_call'] },
    final_answer: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object' },
  },
  required: ['response_type'],
} as const;

export interface StructuredResponse {
  finalText?: string;
  call?: ToolCall;
}

/**
 * Parses a model response that was requested under STRUCTURED_RESPONSE_SCHEMA.
 * Returns undefined (rather than throwing or guessing) if the text isn't
 * valid JSON or doesn't match the expected shape — callers must treat that as
 * "the model didn't actually respect the schema this turn" and fall back to
 * the ordinary defensive parser (see agentLoop.ts's resolveModelResponse()),
 * never as an error that ends the turn. A local model ignoring a requested
 * format from time to time is expected, not exceptional.
 */
export function parseStructuredResponse(raw: string): StructuredResponse | undefined {
  let obj: any;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;

  if (obj.response_type === 'tool_call' && typeof obj.tool === 'string') {
    return { call: { tool: obj.tool, args: obj.args && typeof obj.args === 'object' ? obj.args : {}, raw } };
  }
  if (obj.response_type === 'final_answer') {
    return { finalText: typeof obj.final_answer === 'string' ? obj.final_answer : '' };
  }
  return undefined;
}
