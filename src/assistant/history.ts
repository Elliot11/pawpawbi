// Saved chat messages (chat/messages.jsonl) as the conversation sent to the model.
// No Electron imports, so it's tested with plain Node.
import type { ChatMessage } from '../shared/types';
import type { Turn } from './types';

/** How much of the conversation is sent with each request. */
export const HISTORY_MESSAGES = 80;

/**
 * The most recent messages as the model's conversation, starting at a user message (so a tool
 * result is never sent without the call it answers).
 */
export function toTurns(messages: ChatMessage[]): Turn[] {
  const recent = messages.slice(-HISTORY_MESSAGES);
  const start = recent.findIndex((m) => m.role === 'user');
  return (start === -1 ? [] : recent.slice(start)).flatMap((m): Turn[] => {
    if (m.role === 'user') return [{ role: 'user', text: m.text }];
    if (m.role === 'assistant') {
      return [
        {
          role: 'assistant',
          text: m.text,
          ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
        },
      ];
    }
    if (m.toolCallId) {
      return [
        {
          role: 'tool',
          toolCallId: m.toolCallId,
          name: m.toolName ?? '',
          content: m.text,
          ...(m.isError ? { isError: true } : {}),
        },
      ];
    }
    return [];
  });
}
