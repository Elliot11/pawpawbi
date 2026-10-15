// Main-process handling of project files and the recent projects list.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Project, ProjectFile, RecentProject } from './shared/types';

const PROJECT_EXTENSION = 'pawpaw';
const PROJECT_FILTERS = [{ name: 'PawpawBI project', extensions: [PROJECT_EXTENSION] }];
const MAX_RECENTS = 10;

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

async function addRecent(project: Project) {
  const recents = (await readRecents()).filter((r) => r.path !== project.path);
  recents.unshift({ name: project.name, path: project.path, openedAt: new Date().toISOString() });
  await writeRecents(recents.slice(0, MAX_RECENTS));
}

async function removeRecent(filePath: string) {
  await writeRecents((await readRecents()).filter((r) => r.path !== filePath));
}

async function loadProject(filePath: string): Promise<Project> {
  const data = JSON.parse(await fs.readFile(filePath, 'utf8')) as ProjectFile;
  if (typeof data?.name !== 'string') {
    throw new Error(`${filePath} is not a PawpawBI project`);
  }
  const project: Project = { ...data, path: filePath };
  await addRecent(project);
  return project;
}

const windowFor = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)!;

export function registerProjectHandlers() {
  ipcMain.handle('projects:list-recent', () => readRecents());

  ipcMain.handle('projects:create', async (event) => {
    const { canceled, filePath } = await dialog.showSaveDialog(windowFor(event), {
      title: 'Create project',
      buttonLabel: 'Create',
      defaultPath: path.join(app.getPath('documents'), `Untitled report.${PROJECT_EXTENSION}`),
      filters: PROJECT_FILTERS,
    });
    if (canceled || !filePath) return null;

    const file: ProjectFile = {
      version: 1,
      name: path.basename(filePath, path.extname(filePath)),
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(filePath, JSON.stringify(file, null, 2));
    const project: Project = { ...file, path: filePath };
    await addRecent(project);
    return project;
  });

  ipcMain.handle('projects:open', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(windowFor(event), {
      title: 'Open project',
      properties: ['openFile'],
      filters: PROJECT_FILTERS,
    });
    if (canceled || filePaths.length === 0) return null;
    return loadProject(filePaths[0]);
  });

  ipcMain.handle('projects:open-recent', async (_event, filePath: string) => {
    // Only reopen paths we handed out ourselves, not arbitrary files.
    const recents = await readRecents();
    if (!recents.some((r) => r.path === filePath)) return null;
    try {
      return await loadProject(filePath);
    } catch {
      await removeRecent(filePath);
      return null;
    }
  });
}
