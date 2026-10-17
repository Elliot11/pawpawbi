// Main-process handling of .pawpaw project files, the open project's working folder and the
// recent projects list. File format and open/save behaviour: docs/pawpaw-file-format.md
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  InvalidProjectFileError,
  extractArchive,
  isZipFile,
  packArchive,
  readArchiveEntry,
} from './pawpaw-archive';
import { newId } from './shared/ids';
import type {
  ChatMessage,
  ChatState,
  OpenResult,
  Project,
  ProjectManifest,
  RecentProject,
  WorkflowStage,
} from './shared/types';

const FORMAT_VERSION = 1;
const PROJECT_EXTENSION = 'pawpaw';
const PROJECT_FILTERS = [{ name: 'PawpawBI project', extensions: [PROJECT_EXTENSION] }];
const MAX_RECENTS = 10;
const WORKFLOW_STAGES: WorkflowStage[] = ['data', 'model', 'visuals'];

// ---------------------------------------------------------------------------------------------
// Recent projects

const recentsPath = () => path.join(app.getPath('userData'), 'recent-projects.json');

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
// The open project
//
// An open project is extracted into a working folder, userData/workspaces/<id>-<path hash>/:
//   project/     the archive's contents, which everything reads and writes
//   state.json   which file it came from and whether it has unsaved changes
// The folder is deleted when the project is closed. If the app crashes it survives, and its
// unsaved changes are offered back the next time that file is opened.

interface Session {
  manifest: ProjectManifest;
  filePath: string;
  workspaceDir: string;
  filesDir: string;
  dirty: boolean;
}

interface WorkspaceState {
  filePath: string;
  dirty: boolean;
  updatedAt: string;
}

let session: Session | null = null;

const appLabel = () => `PawpawBI ${app.getVersion()}`;
const now = () => new Date().toISOString();

function workspacePaths(id: string, filePath: string) {
  // Include the file's location so two copies of the same project never share a folder.
  const key = createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 8);
  const workspaceDir = path.join(app.getPath('userData'), 'workspaces', `${id}-${key}`);
  return {
    workspaceDir,
    filesDir: path.join(workspaceDir, 'project'),
    statePath: path.join(workspaceDir, 'state.json'),
  };
}

async function readWorkspaceState(statePath: string): Promise<WorkspaceState | null> {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeWorkspaceState(s: Session) {
  const state: WorkspaceState = { filePath: s.filePath, dirty: s.dirty, updatedAt: now() };
  await fs.writeFile(path.join(s.workspaceDir, 'state.json'), JSON.stringify(state, null, 2));
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n');
}

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
  };
}

/** Updates window titles and tells the renderer the project changed. */
function notifyChanged() {
  for (const win of BrowserWindow.getAllWindows()) {
    win.setTitle(
      session ? `${session.manifest.name}${session.dirty ? ' •' : ''} - PawpawBI` : 'PawpawBI',
    );
    if (process.platform === 'darwin') win.setDocumentEdited(session?.dirty ?? false);
    if (session) win.webContents.send('project:changed', toProject(session));
  }
}

async function markDirty() {
  const s = requireSession();
  if (s.dirty) return;
  s.dirty = true;
  await writeWorkspaceState(s);
  notifyChanged();
}

function parseManifest(text: string): ProjectManifest {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new InvalidProjectFileError('The project file is damaged: manifest.json is not valid JSON.');
  }
  if (typeof manifest?.formatVersion !== 'number') {
    throw new InvalidProjectFileError('The project file is damaged: it has no format version.');
  }
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new InvalidProjectFileError(
      'This project was saved by a newer version of PawpawBI. Update PawpawBI to open it.',
    );
  }
  // The ID becomes part of a folder name, so only allow safe characters.
  if (
    typeof manifest.id !== 'string' ||
    !/^[a-z0-9]{1,32}$/.test(manifest.id) ||
    typeof manifest.name !== 'string'
  ) {
    throw new InvalidProjectFileError('The project file is damaged: manifest.json is incomplete.');
  }
  return manifest;
}

/** Before the ZIP format, a .pawpaw file was a small JSON file: { version, name, createdAt }. */
async function readLegacyProject(filePath: string): Promise<ProjectManifest> {
  let data;
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new InvalidProjectFileError('This is not a PawpawBI project file.');
  }
  if (typeof data?.name !== 'string') {
    throw new InvalidProjectFileError('This is not a PawpawBI project file.');
  }
  return {
    formatVersion: FORMAT_VERSION,
    id: newId(),
    name: data.name,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : now(),
    modifiedAt: now(),
    createdWith: appLabel(),
    modifiedWith: appLabel(),
  };
}

async function askToRecover(win: BrowserWindow, name: string, state: WorkspaceState) {
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

async function openProjectFile(filePath: string, win: BrowserWindow): Promise<Project> {
  if (session) throw new Error('Close the open project first.');

  const isZip = await isZipFile(filePath);
  const manifest = isZip
    ? parseManifest(await readArchiveEntry(filePath, 'manifest.json'))
    : await readLegacyProject(filePath);
  const paths = workspacePaths(manifest.id, filePath);

  const previous = await readWorkspaceState(paths.statePath);
  const recover = previous?.dirty === true && (await askToRecover(win, manifest.name, previous));

  if (!recover) {
    await fs.rm(paths.workspaceDir, { recursive: true, force: true, maxRetries: 5 });
    await fs.mkdir(paths.filesDir, { recursive: true });
    if (isZip) {
      await extractArchive(filePath, paths.filesDir);
    } else {
      await writeJson(path.join(paths.filesDir, 'manifest.json'), manifest);
    }
  }

  session = {
    manifest: recover
      ? parseManifest(await fs.readFile(path.join(paths.filesDir, 'manifest.json'), 'utf8'))
      : manifest,
    filePath,
    workspaceDir: paths.workspaceDir,
    filesDir: paths.filesDir,
    // An old-format file is upgraded in the working folder and written as a ZIP on save.
    dirty: recover || !isZip,
  };
  await writeWorkspaceState(session);
  await addRecent(session.manifest.name, filePath);
  notifyChanged();
  return toProject(session);
}

async function createProject(win: BrowserWindow): Promise<Project | null> {
  if (session) throw new Error('Close the open project first.');

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Create project',
    buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), `Untitled report.${PROJECT_EXTENSION}`),
    filters: PROJECT_FILTERS,
  });
  if (canceled || !filePath) return null;

  const manifest: ProjectManifest = {
    formatVersion: FORMAT_VERSION,
    id: newId(),
    name: path.basename(filePath, path.extname(filePath)),
    createdAt: now(),
    modifiedAt: now(),
    createdWith: appLabel(),
    modifiedWith: appLabel(),
  };
  const paths = workspacePaths(manifest.id, filePath);
  await fs.rm(paths.workspaceDir, { recursive: true, force: true, maxRetries: 5 });
  await writeJson(path.join(paths.filesDir, 'manifest.json'), manifest);
  await packArchive(paths.filesDir, filePath);

  session = { manifest, filePath, ...paths, dirty: false };
  await writeWorkspaceState(session);
  await addRecent(manifest.name, filePath);
  notifyChanged();
  return toProject(session);
}

async function saveProject(): Promise<Project> {
  const s = requireSession();
  s.manifest = { ...s.manifest, modifiedAt: now(), modifiedWith: appLabel() };
  await writeJson(path.join(s.filesDir, 'manifest.json'), s.manifest);
  await packArchive(s.filesDir, s.filePath);
  s.dirty = false;
  await writeWorkspaceState(s);
  notifyChanged();
  return toProject(s);
}

/** Closes the open project, asking to save unsaved changes first. False if the user cancels. */
export async function closeProject(win: BrowserWindow): Promise<boolean> {
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
  await fs.rm(closing.workspaceDir, { recursive: true, force: true, maxRetries: 5 });
  notifyChanged();
  return true;
}

export const hasOpenProject = () => session !== null;

/** The open project's ID and working folder, for other modules that read or write its files. */
export function openProject(): { id: string; filesDir: string } {
  const s = requireSession();
  return { id: s.manifest.id, filesDir: s.filesDir };
}

/** Records that the open project has changed since it was last saved. */
export const markProjectChanged = () => markDirty();

// ---------------------------------------------------------------------------------------------
// Chat (chat/session.json and chat/messages.jsonl)

async function loadChat(): Promise<ChatState> {
  const chatDir = path.join(requireSession().filesDir, 'chat');

  let stage: WorkflowStage = 'data';
  try {
    const saved = JSON.parse(await fs.readFile(path.join(chatDir, 'session.json'), 'utf8'));
    if (WORKFLOW_STAGES.includes(saved?.stage)) stage = saved.stage;
  } catch {
    // No saved session yet.
  }

  let lines: string[] = [];
  try {
    lines = (await fs.readFile(path.join(chatDir, 'messages.jsonl'), 'utf8')).split('\n');
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

async function appendChat(messages: ChatMessage[], stage: WorkflowStage) {
  if (!WORKFLOW_STAGES.includes(stage)) throw new Error(`Unknown workflow stage: ${stage}`);
  const chatDir = path.join(requireSession().filesDir, 'chat');
  await fs.mkdir(chatDir, { recursive: true });
  await fs.appendFile(
    path.join(chatDir, 'messages.jsonl'),
    messages.map((m) => JSON.stringify(m) + '\n').join(''),
  );
  await writeJson(path.join(chatDir, 'session.json'), { stage });
  await markDirty();
}

// ---------------------------------------------------------------------------------------------
// IPC

const windowFor = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)!;

/** Turns failures into a message for the start screen instead of a rejected promise. */
async function toOpenResult(action: () => Promise<Project | null>): Promise<OpenResult> {
  try {
    const project = await action();
    return project && { project };
  } catch (error) {
    if (error instanceof InvalidProjectFileError) return { error: error.message };
    console.error(error);
    return { error: `Something went wrong: ${(error as Error).message}` };
  }
}

export function registerProjectHandlers() {
  ipcMain.handle('projects:list-recent', () => readRecents());

  ipcMain.handle('projects:create', (event) => toOpenResult(() => createProject(windowFor(event))));

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
    if (!recent) return { error: 'That project is no longer in your recent projects.' };
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
  ipcMain.handle('projects:append-chat', (_event, messages: ChatMessage[], stage: WorkflowStage) =>
    appendChat(messages, stage),
  );
}
