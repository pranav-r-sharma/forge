import { ChatMessage } from '../ollama/types';
import { isRealUserTurnContent } from './requirements';

export const DEFAULT_PINNED_USER_MAX_CHARS = 40_000;

const MIDDLE_SUMMARY_HEADER = '[Earlier user follow-ups — summarized to save context; full text remains in saved session history]\n';

/**
 * Pins real user messages from archival[bodyStart..throughIndex) for compaction.
 * When over maxChars: keeps the first and as many recent messages as fit; summarizes the middle.
 */
export function pinUserMessagesForCompaction(
  archival: ChatMessage[],
  bodyStart: number,
  throughIndex: number,
  maxChars: number = DEFAULT_PINNED_USER_MAX_CHARS,
): ChatMessage[] {
  const users: ChatMessage[] = [];
  for (let i = bodyStart; i < throughIndex; i++) {
    const m = archival[i];
    if (m.role === 'user' && isRealUserTurnContent(m.content)) users.push(m);
  }
  if (!users.length) return [];

  const total = users.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars) {
    return users.map((m) => ({ role: 'user' as const, content: m.content }));
  }

  const first = users[0];
  const pinned: ChatMessage[] = [{ role: 'user', content: first.content }];
  let budget = maxChars - first.content.length;

  const tail: ChatMessage[] = [];
  for (let i = users.length - 1; i >= 1; i--) {
    const m = users[i];
    if (m.content.length <= budget) {
      tail.unshift({ role: 'user', content: m.content });
      budget -= m.content.length;
    } else {
      break;
    }
  }

  const tailStartIdx = users.length - tail.length;
  const middle = users.slice(1, tailStartIdx);
  if (middle.length > 0) {
    const lines = middle.map((m, idx) => {
      const excerpt = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
      return `${idx + 2}. ${excerpt.replace(/\n/g, ' ')}`;
    });
    const summaryBody = MIDDLE_SUMMARY_HEADER + lines.join('\n');
    pinned.push({ role: 'user', content: summaryBody });
  }

  pinned.push(...tail);
  return pinned;
}
