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
import { appendChatMessages, loadChat, openProject } from '../projects';
import { readAllSources } from '../data';
import { callPython } from '../python';
import { newId } from '../shared/ids';
import type {
  AssistantEnd,
  AssistantEvent,
  AssistantProvider,
  ChatMessage,
  TableSchema,
} from '../shared/types';
import { INTRO_MESSAGE, STAGES } from '../workflow';
import { anthropic } from './anthropic';
import { toTurns } from './history';
import { runAssistant } from './loop';
import { pickModel } from './models';
import { ollama } from './ollama';
import { openai } from './openai';
import { SYSTEM_PROMPT, projectContext } from './prompt';
import {
  getSettings,
  readKey,
  removeKey,
  saveSettings,
  setKey,
} from './settings';
import { READ_TOOLS } from './tools';
import type { Provider } from './types';

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

          return await runAssistant({
            provider,
            model,
            system: SYSTEM_PROMPT,
            context: await snapshot(chat.stage),
            tools: READ_TOOLS,
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
                      summary: summaries.get(turn.toolCallId) ?? turn.name,
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

export function registerAssistantHandlers() {
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
