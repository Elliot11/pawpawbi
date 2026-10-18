// Publishing reports to PawpawBI and keeping their data fresh. A project records its published
// report in published.json; this computer keeps a list of every published project
// (published-reports.json in userData) for the Published projects screen. The list can always
// be rebuilt from the project files. Server API: docs/pawpaw-server-api.md
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forgetIfSignedOut, signedInServer } from './account';
import { refreshAll } from './data';
import { readJson, removePath, writeJson } from './fs-json';
import { readArchiveEntry, zipFolder } from './pawpaw-archive';
import {
  closeProjectQuietly,
  hasOpenProject,
  markProjectChanged,
  onProjectOpened,
  openProject,
  openProjectInBackground,
  readRecents,
  saveProject,
  tracked,
} from './projects';
import {
  cleanList,
  cleanPublished,
  publishedFile,
  withEntry,
} from './published-files';
import { refreshDatasets } from './report';
import { exportSite, hasSite, readReport } from './report-site';
import { parseManifest } from './workspace';
import type { PublishedProject, PublishedReport } from './shared/types';

// --- The project's record (published.json) -----------------------------------------------------

const publishedPath = (filesDir: string) =>
  path.join(filesDir, 'published.json');

const readPublished = (filesDir: string) =>
  readJson(publishedPath(filesDir), cleanPublished);

async function writePublished(report: PublishedReport) {
  await writeJson(publishedPath(openProject().filesDir), publishedFile(report));
  await markProjectChanged();
}

// --- This computer's list (published-reports.json) ---------------------------------------------

const listPath = () =>
  path.join(app.getPath('userData'), 'published-reports.json');

const readList = () => readJson(listPath(), cleanList);

const writeList = (list: PublishedProject[]) =>
  writeJson(listPath(), { projects: list });

/** Adds or updates the open project's entry in the list. */
async function listOpenProject(report: PublishedReport, lastError?: string) {
  const project = openProject();
  const entry: PublishedProject = {
    ...report,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.filePath,
    ...(lastError ? { lastError } : {}),
  };
  await writeList(withEntry(await readList(), entry));
  return entry;
}

/** A published project in a .pawpaw file, read without opening it; null if it isn't one. */
async function entryFromFile(
  filePath: string,
): Promise<PublishedProject | null> {
  const report = cleanPublished(
    JSON.parse(await readArchiveEntry(filePath, 'published.json')),
  );
  if (!report) return null;
  const manifest = parseManifest(
    await readArchiveEntry(filePath, 'manifest.json'),
  );
  return {
    ...report,
    projectId: manifest.id,
    projectName: manifest.name,
    projectPath: filePath,
  };
}

/** The list, rebuilt from the recent projects' files if it's been lost. */
async function list(): Promise<PublishedProject[]> {
  const exists = await fs
    .access(listPath())
    .then(() => true)
    .catch(() => false);
  if (exists) return readList();
  let rebuilt: PublishedProject[] = [];
  for (const recent of await readRecents()) {
    const entry = await entryFromFile(recent.path).catch(() => null);
    if (entry) rebuilt = withEntry(rebuilt, entry);
  }
  await writeList(rebuilt);
  return rebuilt;
}

/** Adds published projects from files the user picks. Files that aren't published are skipped. */
async function addFiles(win: BrowserWindow): Promise<PublishedProject[]> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Add published projects',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PawpawBI project', extensions: ['pawpaw'] }],
  });
  let entries = await list();
  if (canceled) return entries;
  const notPublished: string[] = [];
  for (const filePath of filePaths) {
    const entry = await entryFromFile(filePath).catch(() => null);
    if (entry) entries = withEntry(entries, entry);
    else notPublished.push(path.basename(filePath));
  }
  await writeList(entries);
  if (notPublished.length) {
    throw new Error(
      `${notPublished.join(', ')} ${notPublished.length === 1 ? "hasn't" : "haven't"} been published to PawpawBI, so ${notPublished.length === 1 ? "it wasn't" : "they weren't"} added.`,
    );
  }
  return entries;
}

// --- Publishing ------------------------------------------------------------------------------------

/** Runs `use` with a temporary folder that's removed afterwards. */
async function withTempDir<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-publish-'));
  try {
    return await use(dir);
  } finally {
    await removePath(dir);
  }
}

/** The site as Publish to a folder writes it, zipped. */
const siteZip = (filesDir: string) =>
  withTempDir(async (dir) => {
    const site = path.join(dir, 'site');
    await exportSite(filesDir, site);
    return zipFolder(site);
  });

/** The report's data files, zipped. */
const dataZip = (filesDir: string) =>
  zipFolder(path.join(filesDir, 'report'), (file) =>
    /^data\/[^/]+\.json$/.test(file),
  );

/**
 * Publishes the open project's report to PawpawBI: the first time, a new report; after that,
 * the same report again, so its address doesn't change.
 */
async function publishToPawpawBI(): Promise<PublishedReport> {
  const { filesDir } = openProject();
  if (!(await hasSite(filesDir))) {
    throw new Error(
      'This project has no report yet. Add one on Build visuals.',
    );
  }
  return tracked('Publishing the report', async () => {
    const { server, saved } = await signedInServer();
    try {
      const previous = await readPublished(filesDir);
      if (
        previous &&
        previous.account &&
        previous.account !== saved.account.email
      ) {
        throw new Error(
          `This report was published from another PawpawBI account (${previous.account}). Sign in with that account to publish it again.`,
        );
      }
      await refreshDatasets();
      const zip = await siteZip(filesDir);
      let id = previous?.reportId;
      if (!id) {
        id = (await server.createReport((await readReport(filesDir)).title)).id;
      }
      const hosted = await server.uploadSite(id, zip);
      const report: PublishedReport = {
        reportId: hosted.id,
        url: hosted.url,
        account: saved.account.email,
        publishedAt: hosted.publishedAt,
        refreshedAt: hosted.refreshedAt,
      };
      await writePublished(report);
      await listOpenProject(report);
      return report;
    } catch (error) {
      return forgetIfSignedOut(error);
    }
  });
}

/**
 * Refreshes a published project from the start screen: opens it in the background, loads every
 * data source again (rebuilding tables and datasets), uploads the report's new data, saves the
 * project and closes it.
 */
async function refresh(projectPath: string): Promise<PublishedProject> {
  if (hasOpenProject()) throw new Error('Close the open project first.');
  const entry = (await list()).find((e) => e.projectPath === projectPath);
  if (!entry) throw new Error('That project isn’t in the published list.');
  const remember = async (lastError: string) => {
    const failed = { ...entry, lastError };
    await writeList(withEntry(await readList(), failed));
    return failed;
  };
  try {
    await fs.access(projectPath);
  } catch {
    await remember(
      'The project file couldn’t be found. Was it moved or renamed?',
    );
    throw new Error(
      `"${entry.projectName}" couldn't be found at ${projectPath}. If it was moved, add it again with Add a project.`,
    );
  }

  const { server } = await signedInServer();
  await openProjectInBackground(projectPath);
  try {
    const { filesDir } = openProject();
    const report = await readPublished(filesDir);
    if (!report) throw new Error('This project isn’t published any more.');
    const { updated, problems } = await tracked(
      'Refreshing the published report',
      async () => {
        const result = await refreshAll();
        const hosted = await server
          .uploadData(report.reportId, await dataZip(filesDir))
          .catch(forgetIfSignedOut);
        const updated = { ...report, refreshedAt: hosted.refreshedAt };
        await writePublished(updated);
        const problems = [
          ...result.failedSources.map((s) => `${s.name}: ${s.error}`),
          ...result.failedTables.map((t) => `${t.name}: ${t.error}`),
        ];
        return { updated, problems };
      },
    );
    // After the task: saving waits for the project's background work to finish.
    await saveProject();
    return await listOpenProject(
      updated,
      problems.length
        ? `Refreshed, with problems. ${problems.join(' ')}`
        : undefined,
    );
  } catch (error) {
    await remember((error as Error).message);
    throw error;
  } finally {
    await closeProjectQuietly();
  }
}

export function registerPublishHandlers() {
  // A published project opened on this computer is (re)listed, with its current path.
  onProjectOpened(async () => {
    const report = await readPublished(openProject().filesDir);
    if (report) await listOpenProject(report);
  });

  ipcMain.handle('publish:get', () => readPublished(openProject().filesDir));
  ipcMain.handle('publish:to-pawpawbi', () => publishToPawpawBI());
  ipcMain.handle('publish:list', () => list());
  ipcMain.handle('publish:refresh', (_event, projectPath: string) =>
    refresh(String(projectPath)),
  );
  ipcMain.handle('publish:add-files', (event) =>
    addFiles(BrowserWindow.fromWebContents(event.sender)!),
  );
}
