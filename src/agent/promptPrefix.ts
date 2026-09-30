import { ChatMessage } from '../ollama/types';

/** Wire-format prefix used for cache-prefix comparisons (role + content, in order). */
export function serializePromptMessages(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role}\u0000${m.content}`).join('\u0001');
}

/** Longest shared prefix of two serialized prompts, bytes. */
export function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return n;
}

/**
 * True when `next` is exactly `prev` plus new tail message(s) — the shape local runtimes need for prompt-cache / KV-prefix reuse.
 */
export function isPromptPrefixExtension(prev: ChatMessage[], next: ChatMessage[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].role !== next[i].role || prev[i].content !== next[i].content) return false;
  }
  return next.length > prev.length;
}
