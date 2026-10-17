// Main-process handling of .pawpaw project files, the open project's working folder and the
// recent projects list. File format and open/save behaviour: docs/pawpaw-file-format.md
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidProjectFileError } from './pawpaw-archive';
import { work } from './background';
import { stopPython } from './python';
import { createSite } from './report-site';
import { SITE_TEMPLATES } from './report-templates';
import type {
  ChatMessage,
  ChatState,
  OpenResult,
  Project,
  RecentProject,
  WorkflowStage,
} from './shared/types';
import {
  createWorkspace,
  markWorkspaceDirty,
  openWorkspace,
  removeWorkspace,
  saveWorkspace,
  writeJson,
  type Workspace,
  type WorkspaceOptions,
  type WorkspaceState,
} from './workspace';

const PROJECT_EXTENSION = 'pawpaw';
const PROJECT_FILTERS = [
  { name: 'PawpawBI project', extensions: [PROJECT_EXTENSION] },
];
const MAX_RECENTS = 10;
const WORKFLOW_STAGES: WorkflowStage[] = ['data', 'model', 'visuals'];

// ---------------------------------------------------------------------------------------------
// Recent projects

const recentsPath = () =>
  path.join(app.getPath('userData'), 'recent-projects.json');

async function readRecents(): Promise<RecentProject[]> {
  try {
    return JSON.parse(await fs.readFile(recentsPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeRecents(recents: RecentProject[]) {
  await fs.writeFile(recentsPath(), JSON.stringify(recents, null, 2));
}

async function addRecent(name: string, filePath: string) {
  const recents = (await readRecents()).filter((r) => r.path !== filePath);
  recents.unshift({ name, path: filePath, openedAt: new Date().toISOString() });
  await writeRecents(recents.slice(0, MAX_RECENTS));
}

async function removeRecent(filePath: string) {
  await writeRecents((await readRecents()).filter((r) => r.path !== filePath));
}

// ---------------------------------------------------------------------------------------------
// The open project. Its working folder and crash recovery are in workspace.ts; this module adds
// the dialogs, the recent list, window updates and IPC.

type Session = Workspace;

let session: Session | null = null;

const appLabel = () => `PawpawBI ${app.getVersion()}`;

const workspaceOptions = (): WorkspaceOptions => ({
  root: path.join(app.getPath('userData'), 'workspaces'),
  appLabel: appLabel(),
});

function requireSession(): Session {
  if (!session) throw new Error('No project is open.');
  return session;
}

function toProject(s: Session): Project {
  return {
    id: s.manifest.id,
    name: s.manifest.name,
    path: s.filePath,
    createdAt: s.manifest.createdAt,
    modifiedAt: s.manifest.modifiedAt,
    dirty: s.dirty,
    busy: work.running(s.manifest.id).length > 0,
  };
}

// The renderer shows when background work is running (and Save waits for it).
work.onChange(() => notifyChanged());

/** Updates window titles and tells the renderer the project changed. */
function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setTitle(
      session
        ? `${session.manifest.name}${session.dirty ? ' •' : ''} - PawpawBI`
        : 'PawpawBI',
    );
    if (process.platform === 'darwin')
      win.setDocumentEdited(session?.dirty ?? false);
    if (session) win.webContents.send('project:changed', toProject(session));
  }
}

async function markDirty() {
  if (await markWorkspaceDirty(requireSession())) notifyChanged();
}

async function askToRecover(
  win: BrowserWindow,
  name: string,
  state: WorkspaceState,
) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Recover', 'Discard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Recover unsaved changes',
    message: `"${name}" has unsaved changes from ${new Date(state.updatedAt).toLocaleString()}.`,
    detail:
      'PawpawBI closed before they were saved. Recover them, or discard them and open the last saved version?',
  });
  return response === 0;
}

async function openProjectFile(
  filePath: string,
  win: BrowserWindow,
): Promise<Project> {
  if (session) throw new Error('Close the open project first.');

  session = await openWorkspace(filePath, {
    ...workspaceOptions(),
    askToRecover: (name, state) => askToRecover(win, name, state),
  });
  await addRecent(session.manifest.name, filePath);
  notifyChanged();
  return toProject(session);
}

async function createProject(win: BrowserWindow): Promise<Project | null> {
  if (session) throw new Error('Close the open project first.');

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Create project',
    buttonLabel: 'Create',
    defaultPath: path.join(
      app.getPath('documents'),
      `Untitled report.${PROJECT_EXTENSION}`,
    ),
    filters: PROJECT_FILTERS,
  });
  if (canceled || !filePath) return null;

  // New projects start with the default report, ready to build on.
  session = await createWorkspace(filePath, {
    ...workspaceOptions(),
    populate: (filesDir, name) => createSite(filesDir, name, SITE_TEMPLATES),
  });
  await addRecent(session.manifest.name, filePath);
  notifyChanged();
  return toProject(session);
}

async function saveProject(): Promise<Project> {
  const s = requireSession();
  // Never zip a working folder that a load or rebuild is still writing to.
  await work.idle(s.manifest.id);
  await saveWorkspace(s, appLabel());
  notifyChanged();
  return toProject(s);
}

/**
 * Waits for, or stops, the open project's background work before it's closed: closing deletes
 * the working folder that work writes to. False if the user chooses to keep working.
 */
async function finishBackgroundWork(win: BrowserWindow, projectId: string) {
  const running = [...new Set(work.running(projectId))];
  if (running.length === 0) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Wait', 'Stop and close', 'Keep working'],
    defaultId: 0,
    cancelId: 2,
    title: 'Still working',
    message:
      running.length === 1
        ? `${running[0]} is still in progress.`
        : `${running.join(', ')} are still in progress.`,
    detail:
      'Wait closes the project as soon as it finishes. Stop and close ends it now; tables it was loading or building may be incomplete, so refresh them next time.',
  });
  if (response === 2) return false;
  // Nothing new can start for this project from here on.
  work.block(projectId);
  try {
    if (response === 1) {
      work.cancel(projectId);
      // Also interrupts anything the Python sidecar is doing; it restarts on next use.
      stopPython();
    }
    await work.idle(projectId);
  } finally {
    work.unblock(projectId);
  }
  return true;
}

/** Closes the open project, asking to save unsaved changes first. False if the user cancels. */
export async function closeProject(win: BrowserWindow): Promise<boolean> {
  if (!session) return true;
  if (!(await finishBackgroundWork(win, session.manifest.id))) return false;
  if (!session) return true;
  if (session.dirty) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: `Save changes to "${session.manifest.name}"?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    if (response === 2) return false;
    if (response === 0) await saveProject();
  }
  const closing = session;
  session = null;
  await removeWorkspace(closing);
  notifyChanged();
  return true;
}

export const hasOpenProject = () => session !== null;

/** The open project's ID, name and working folder, for other modules that use its files. */
export function openProject(): { id: string; name: string; filesDir: string } {
  const s = requireSession();
  return { id: s.manifest.id, name: s.manifest.name, filesDir: s.filesDir };
}

/** Records that the open project has changed since it was last saved. */
export const markProjectChanged = () => markDirty();

// ---------------------------------------------------------------------------------------------
// Chat (chat/session.json and chat/messages.jsonl)

export async function loadChat(): Promise<ChatState> {
  const chatDir = path.join(requireSession().filesDir, 'chat');

  let stage: WorkflowStage = 'data';
  try {
    const saved = JSON.parse(
      await fs.readFile(path.join(chatDir, 'session.json'), 'utf8'),
    );
    if (WORKFLOW_STAGES.includes(saved?.stage)) stage = saved.stage;
  } catch {
    // No saved session yet.
  }

  let lines: string[] = [];
  try {
    lines = (
      await fs.readFile(path.join(chatDir, 'messages.jsonl'), 'utf8')
    ).split('\n');
  } catch {
    // No messages yet.
  }
  const messages = lines.flatMap((line): ChatMessage[] => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // Skip a damaged line rather than lose the whole conversation.
    }
  });
  return { stage, messages };
}

async function setStage(stage: WorkflowStage) {
  if (!WORKFLOW_STAGES.includes(stage))
    throw new Error(`Unknown workflow stage: ${stage}`);
  await writeJson(
    path.join(requireSession().filesDir, 'chat', 'session.json'),
    { stage },
  );
  await markDirty();
}

/** Adds messages to the end of the conversation. */
export async function appendChatMessages(messages: ChatMessage[]) {
  const chatDir = path.join(requireSession().filesDir, 'chat');
  await fs.mkdir(chatDir, { recursive: true });
  await fs.appendFile(
    path.join(chatDir, 'messages.jsonl'),
    messages.map((m) => JSON.stringify(m) + '\n').join(''),
  );
  await markDirty();
}

async function appendChat(messages: ChatMessage[], stage: WorkflowStage) {
  await appendChatMessages(messages);
  await setStage(stage);
}

// ---------------------------------------------------------------------------------------------
// IPC

const windowFor = (event: IpcMainInvokeEvent) =>
  BrowserWindow.fromWebContents(event.sender)!;

/** Turns failures into a message for the start screen instead of a rejected promise. */
async function toOpenResult(
  action: () => Promise<Project | null>,
): Promise<OpenResult> {
  try {
    const project = await action();
    return project && { project };
  } catch (error) {
    if (error instanceof InvalidProjectFileError)
      return { error: error.message };
    console.error(error);
    return { error: `Something went wrong: ${(error as Error).message}` };
  }
}

export function registerProjectHandlers() {
  ipcMain.handle('projects:list-recent', () => readRecents());

  ipcMain.handle('projects:create', (event) =>
    toOpenResult(() => createProject(windowFor(event))),
  );

  ipcMain.handle('projects:open', (event) =>
    toOpenResult(async () => {
      const win = windowFor(event);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Open project',
        properties: ['openFile'],
        filters: PROJECT_FILTERS,
      });
      if (canceled || filePaths.length === 0) return null;
      return openProjectFile(filePaths[0], win);
    }),
  );

  ipcMain.handle('projects:open-recent', async (event, filePath: string) => {
    // Only reopen paths we handed out ourselves, not arbitrary files.
    const recent = (await readRecents()).find((r) => r.path === filePath);
    if (!recent)
      return { error: 'That project is no longer in your recent projects.' };
    try {
      await fs.access(filePath);
    } catch {
      await removeRecent(filePath);
      return {
        error: `"${recent.name}" couldn't be found, so it was removed from your recent projects.`,
      };
    }
    return toOpenResult(() => openProjectFile(filePath, windowFor(event)));
  });

  ipcMain.handle('projects:save', () => saveProject());
  ipcMain.handle('projects:close', (event) => closeProject(windowFor(event)));
  ipcMain.handle('projects:load-chat', () => loadChat());
  ipcMain.handle(
    'projects:append-chat',
    (_event, messages: ChatMessage[], stage: WorkflowStage) =>
      appendChat(messages, stage),
  );
  ipcMain.handle('projects:set-stage', (_event, stage: WorkflowStage) =>
    setStage(stage),
  );
}
