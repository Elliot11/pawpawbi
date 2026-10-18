// Undoing the assistant's changes: the project's change journal, and the undo itself.
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import {
  appendChatMessages,
  markProjectChanged,
  openProject,
  tracked,
} from '../projects';
import type { AssistantChange } from '../shared/types';
import { ChangeJournal } from './changes';
import { claim, emitter, message } from './chat';

/**
 * The open project's change journal. Its store is in the working folder, beside the files, and
 * goes when the project is closed, so the journal is opened afresh each time rather than kept:
 * a kept one would still list changes whose copies are gone.
 */
export const journal = () =>
  new ChangeJournal(
    openProject().filesDir,
    path.join(path.dirname(openProject().filesDir), 'assistant-changes'),
  );

/**
 * Undoes a change and every later one (asking first, through `conflicts`, if any of their files
 * were edited since), then tells the assistant, so it knows those changes are gone.
 */
export async function undo(
  event: IpcMainInvokeEvent,
  id: string,
  force = false,
): Promise<{ undone: AssistantChange[]; conflicts: string[] }> {
  const release = claim('undo');
  try {
    return await tracked('Undoing the assistant’s changes', async () => {
      const conflicts = await journal().conflicts(id);
      if (conflicts.length && !force) return { undone: [], conflicts };
      const undone = await journal().undoBackTo(id);
      await markProjectChanged();
      const summaries = undone.map((c) => c.summary).join('; ');
      const note = message({
        role: 'user',
        event: true,
        summary: `Undid: ${summaries}`,
        text: `[I undid your ${undone.length === 1 ? 'change' : 'changes'}: ${summaries}. They're no longer in the project.]`,
      });
      await appendChatMessages([note]);
      const emit = emitter(event);
      emit({ type: 'message', message: note });
      emit({ type: 'changed', areas: ['sources', 'model', 'report'] });
      return { undone, conflicts: [] };
    });
  } finally {
    release();
  }
}
