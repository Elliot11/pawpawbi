// Main-process side of the assistant: settings and keys, and running a reply (the tool loop in
// loop.ts) against the chosen provider, saving every step to the chat (chat/messages.jsonl).
// Calls to the providers are made from here with Node's fetch, so they don't go through the
// app windows' network lockdown (report.ts), which only covers the windows.
// Design: docs/assistant.md
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { work } from '../background';
import { listDatasets } from '../report';
import { hasSite, readReport } from '../report-site';
import {
  appendChatMessages,
  loadChat,
  markProjectChanged,
  openProject,
} from '../projects';
import { readAllSources } from '../data';
import { callPython } from '../python';
import { newId } from '../shared/ids';
import type {
  ApprovalAnswer,
  AssistantChange,
  AssistantEnd,
  AssistantEvent,
  AssistantPermissions,
  AssistantProvider,
  ChatMessage,
  TableSchema,
  WorkflowStage,
} from '../shared/types';
import { INTRO_MESSAGE, STAGES } from '../workflow';
import { anthropic } from './anthropic';
import { ChangeJournal, type ChangeRecord } from './changes';
import { toTurns } from './history';
import { NOT_ALLOWED, runAssistant } from './loop';
import { pickModel } from './models';
import { ollama } from './ollama';
import { openai } from './openai';
import { SYSTEM_PROMPT, projectContext } from './prompt';
import { reportTools, type ToolContext } from './report-tools';
import {
  getSettings,
  readKey,
  removeKey,
  saveSettings,
  setKey,
  setPermissions,
} from './settings';
import { READ_TOOLS } from './tools';
import type { Provider, ToolSpec } from './types';

/** The provider, with its key (read here, in the main process only) if it needs one. */
async function providerFor(id: AssistantProvider): Promise<Provider> {
  // Development only: point a provider at a local stand-in server, to try the chat without
  // calling the real API, e.g. PAWPAW_ANTHROPIC_API=http://127.0.0.1:8787/v1.
  const local = app.isPackaged
    ? undefined
    : process.env[`PAWPAW_${id.toUpperCase()}_API`];
  if (id === 'ollama') return ollama(local);
  const key = await requireKey(id);
  return id === 'openai'
    ? openai(key, fetch, local)
    : anthropic(key, fetch, local);
}

async function requireKey(id: AssistantProvider) {
  const key = await readKey(id);
  if (!key) {
    throw new Error(
      `Add your ${id === 'openai' ? 'OpenAI' : 'Anthropic'} API key in Assistant settings first.`,
    );
  }
  return key;
}

const message = (
  fields: Omit<ChatMessage, 'id' | 'createdAt'>,
): ChatMessage => ({
  id: newId(),
  createdAt: new Date().toISOString(),
  ...fields,
});

/** The project as it is now, for the request's context. Anything unavailable is left out. */
async function snapshot(stage: string) {
  const project = openProject();
  const [sources, tables, report] = await Promise.all([
    readAllSources().catch(() => []),
    callPython<TableSchema[]>('describe_tables', {
      data_dir: path.join(project.filesDir, 'data'),
    }).catch(() => []),
    (async () => {
      if (!(await hasSite(project.filesDir))) return null;
      const site = await readReport(project.filesDir);
      const datasets = await listDatasets().catch(() => []);
      return {
        pages: site.pages.map((p) => `${p.title} (pages/${p.id}.html)`),
        datasets: datasets.map((d) => ({
          name: d.name,
          ...(d.error ? { error: d.error } : {}),
        })),
      };
    })().catch(() => null),
  ]);
  return projectContext({
    name: project.name,
    step: STAGES.find((s) => s.id === stage)?.label ?? stage,
    sources: sources.map((s) => ({
      name: s.name,
      type: s.type,
      tables: s.tables,
      lastLoadedAt: s.lastLoadedAt,
    })),
    tables: tables.map((t) => ({ name: t.name, kind: t.kind, rows: t.rows })),
    report,
  });
}

// ---------------------------------------------------------------------------------------------
// Changes: the journal for Undo, and asking before each change

/**
 * The open project's change journal. Its store is in the working folder, beside the files, and
 * goes when the project is closed, so the journal is opened afresh each time rather than kept:
 * a kept one would still list changes whose copies are gone.
 */
const journal = () =>
  new ChangeJournal(
    openProject().filesDir,
    path.join(path.dirname(openProject().filesDir), 'assistant-changes'),
  );

/** Approval requests waiting for the user's answer, by tool call ID. */
const waiting = new Map<string, (answer: ApprovalAnswer) => void>();

/**
 * The tools offered: everything for Claude and ChatGPT; for small local models (Ollama), the
 * read tools and only the current step's changes, so there are fewer to choose from.
 */
function toolsFor(
  provider: AssistantProvider,
  stage: WorkflowStage,
  ctx: ToolContext,
) {
  const changes = reportTools(ctx);
  const offered: ToolSpec[] =
    provider === 'ollama'
      ? changes.filter((t) => !t.step || t.step === stage)
      : changes;
  return [...READ_TOOLS, ...offered];
}

let running: AbortController | null = null;

/**
 * Runs a reply. With text, it's a new message from the user; with null, it tries the last
 * reply again (after an error), continuing from the conversation as saved.
 */
async function reply(
  event: IpcMainInvokeEvent,
  text: string | null,
): Promise<AssistantEnd> {
  if (text !== null && (typeof text !== 'string' || !text.trim())) {
    throw new Error('Type a message first.');
  }
  if (running) throw new Error('The assistant is still replying.');
  const settings = await getSettings();
  const provider = await providerFor(settings.provider);
  const model = pickModel(
    settings.provider,
    [],
    settings.models[settings.provider],
  );
  if (!model) {
    throw new Error('Choose a model in Assistant settings first.');
  }
  const emit = (e: AssistantEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send('assistant:event', e);
  };

  const controller = new AbortController();
  running = controller;
  try {
    return await work.run(
      openProject().id,
      'The assistant is replying',
      async () => {
        const stopOnCancel = work.onCancel(() => controller.abort());
        try {
          const chat = await loadChat();
          const added: ChatMessage[] = [];
          // The welcome message is saved with the first reply, like the chat panel shows it.
          if (text !== null) {
            if (!chat.messages.length) {
              added.push(message({ role: 'assistant', text: INTRO_MESSAGE }));
            }
            added.push(message({ role: 'user', text: text.trim() }));
          } else if (!chat.messages.some((m) => m.role === 'user')) {
            throw new Error('There’s nothing to try again.');
          }
          await appendChatMessages(added);
          for (const m of added) emit({ type: 'message', message: m });
          const summaries = new Map<string, string>();
          // Tool call ID -> the change it made.
          const made = new Map<string, ChangeRecord>();
          const ctx: ToolContext = {
            change: async (call, summary, targets, operation) => {
              const { result, record } = await journal().record(
                summary,
                targets,
                operation,
              );
              made.set(call.id, record);
              await markProjectChanged();
              emit({ type: 'changed', areas: ['report'] });
              return result;
            },
            show: (stage, pageId) => emit({ type: 'show', stage, pageId }),
          };
          const approve = async (call: { id: string }, summary: string) => {
            summaries.set(call.id, summary);
            if ((await getSettings()).permissions === 'allow') return true;
            const answer = await new Promise<ApprovalAnswer>((resolve) => {
              waiting.set(call.id, resolve);
              controller.signal.addEventListener(
                'abort',
                () => resolve('deny'),
                {
                  once: true,
                },
              );
              emit({ type: 'approval', id: call.id, summary });
            });
            waiting.delete(call.id);
            if (answer === 'allow-all') await setPermissions('allow');
            return answer !== 'deny';
          };

          return await runAssistant({
            provider,
            model,
            system: SYSTEM_PROMPT,
            context: await snapshot(chat.stage),
            tools: toolsFor(settings.provider, chat.stage, ctx),
            approve,
            history: toTurns([...chat.messages, ...added]),
            signal: controller.signal,
            onText: (t) => emit({ type: 'text', text: t }),
            onToolStart: (call, summary) => {
              summaries.set(call.id, summary);
              emit({ type: 'tool', id: call.id, summary, status: 'running' });
            },
            onToolEnd: (call, ok) =>
              emit({
                type: 'tool',
                id: call.id,
                summary: summaries.get(call.id) ?? call.name,
                status: ok ? 'done' : 'failed',
              }),
            onTurn: async (turn) => {
              const saved =
                turn.role === 'tool'
                  ? message({
                      role: 'tool',
                      text: turn.content,
                      toolCallId: turn.toolCallId,
                      toolName: turn.name,
                      summary:
                        turn.content === NOT_ALLOWED
                          ? `Not allowed: ${summaries.get(turn.toolCallId) ?? turn.name}`
                          : (made.get(turn.toolCallId)?.summary ??
                            summaries.get(turn.toolCallId) ??
                            turn.name),
                      ...(turn.content === NOT_ALLOWED
                        ? { declined: true }
                        : {}),
                      ...(made.has(turn.toolCallId)
                        ? { changeId: made.get(turn.toolCallId)!.id }
                        : {}),
                      ...(turn.isError ? { isError: true } : {}),
                    })
                  : turn.role === 'assistant'
                    ? message({
                        role: 'assistant',
                        text: turn.text,
                        ...(turn.toolCalls?.length
                          ? { toolCalls: turn.toolCalls }
                          : {}),
                      })
                    : message({ role: 'user', text: turn.text });
              await appendChatMessages([saved]);
              emit({ type: 'message', message: saved });
            },
          });
        } finally {
          stopOnCancel();
        }
      },
    );
  } finally {
    running = null;
  }
}

/**
 * Undoes a change and every later one (asking first, through `conflicts`, if any of their files
 * were edited since), then tells the assistant, so it knows those changes are gone.
 */
async function undo(
  event: IpcMainInvokeEvent,
  id: string,
  force = false,
): Promise<{ undone: AssistantChange[]; conflicts: string[] }> {
  if (running) {
    throw new Error(
      'Wait for the assistant to finish, or stop it, before undoing.',
    );
  }
  return work.run(
    openProject().id,
    'Undoing the assistant’s changes',
    async () => {
      const conflicts = await journal().conflicts(id);
      if (conflicts.length && !force) return { undone: [], conflicts };
      const undone = await journal().undoBackTo(id);
      await markProjectChanged();
      const note = message({
        role: 'user',
        event: true,
        summary: `Undid: ${undone.map((c) => c.summary).join('; ')}`,
        text: `[I undid your ${undone.length === 1 ? 'change' : 'changes'}: ${undone
          .map((c) => c.summary)
          .join('; ')}. They're no longer in the project.]`,
      });
      await appendChatMessages([note]);
      const send = (e: AssistantEvent) => {
        if (!event.sender.isDestroyed())
          event.sender.send('assistant:event', e);
      };
      send({ type: 'message', message: note });
      send({ type: 'changed', areas: ['sources', 'model', 'report'] });
      return { undone, conflicts: [] };
    },
  );
}

export function registerAssistantHandlers() {
  ipcMain.handle(
    'assistant:answer',
    (_event, id: string, answer: ApprovalAnswer) => {
      waiting.get(id)?.(
        ['allow', 'allow-all', 'deny'].includes(answer) ? answer : 'deny',
      );
    },
  );
  ipcMain.handle(
    'assistant:set-permissions',
    (_event, permissions: AssistantPermissions) => setPermissions(permissions),
  );
  ipcMain.handle('assistant:list-changes', () => journal().list());
  ipcMain.handle('assistant:undo', (event, id: string, force?: boolean) =>
    undo(event, id, force === true),
  );
  ipcMain.handle('assistant:get-settings', () => getSettings());
  ipcMain.handle(
    'assistant:save-settings',
    (_event, provider: AssistantProvider, model: string) =>
      saveSettings(provider, model),
  );
  ipcMain.handle(
    'assistant:set-key',
    (_event, provider: AssistantProvider, key: string) => setKey(provider, key),
  );
  ipcMain.handle(
    'assistant:remove-key',
    (_event, provider: AssistantProvider) => removeKey(provider),
  );
  ipcMain.handle(
    'assistant:list-models',
    async (_event, provider: AssistantProvider) =>
      (await providerFor(provider)).listModels(AbortSignal.timeout(20_000)),
  );
  ipcMain.handle('assistant:send', (event, text: string) => reply(event, text));
  ipcMain.handle('assistant:retry', (event) => reply(event, null));
  ipcMain.handle('assistant:stop', () => running?.abort());
}
