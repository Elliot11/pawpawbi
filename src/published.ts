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
import { listFiles, readArchiveEntry } from './pawpaw-archive';
import {
  MissingFilesError,
  uploadFiles,
  packFile,
  type PawpawServer,
  type ServerReport,
} from './pawpaw-server';
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
import { exportSite, hasSite, readReport, SITE_TYPES } from './report-site';
import { parseManifest } from './workspace';
import type {
  PublishedProject,
  PublishedReport,
  PublishProgress,
} from './shared/types';

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

type Packed = ReturnType<typeof packFile>;

/** The files of a folder that the site serves (or those `include` picks), gzipped to upload. */
async function packFolder(
  dir: string,
  include: (file: string) => boolean = () => true,
): Promise<Packed[]> {
  const packed: Packed[] = [];
  for (const file of await listFiles(dir)) {
    const type = SITE_TYPES[path.extname(file).toLowerCase()];
    if (!type || !include(file)) continue;
    packed.push(
      packFile(
        file,
        await fs.readFile(path.join(dir, ...file.split('/'))),
        type,
      ),
    );
  }
  return packed;
}

/** The site as Publish to a folder writes it (with the menu in every page), gzipped. */
const packSite = (filesDir: string) =>
  withTempDir(async (dir) => {
    const site = path.join(dir, 'site');
    await exportSite(filesDir, site);
    return packFolder(site);
  });

/** The report's data files, gzipped. */
const packData = (filesDir: string) =>
  packFolder(path.join(filesDir, 'report'), (file) =>
    /^data\/[^/]+\.json$/.test(file),
  );

/** Tells every window how the upload is going (a progress bar). */
function sendProgress(progress: PublishProgress) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('publish:progress', progress);
  }
}

/**
 * Uploads a new version of a report straight to S3 (a few files at a time, with progress),
 * then tells the server, which checks they're all there and makes it the current version.
 * Files it says are missing are uploaded once more.
 */
async function uploadVersion(
  server: PawpawServer,
  packed: Packed[],
  start: (files: Packed['file'][]) => ReturnType<PawpawServer['updateReport']>,
): Promise<ServerReport> {
  sendProgress({ stage: 'preparing', sent: 0, total: 0 });
  const { report, version, uploads } = await start(packed.map((p) => p.file));
  const progress = (sent: number, total: number) =>
    sendProgress({ stage: 'uploading', sent, total });
  await uploadFiles(server, packed, uploads, progress);
  sendProgress({ stage: 'finishing', sent: 1, total: 1 });
  try {
    return await server.completeUpload(report.id, version);
  } catch (error) {
    if (!(error instanceof MissingFilesError)) throw error;
    await uploadFiles(
      server,
      packed,
      uploads.filter((u) => error.missing.includes(u.path)),
      progress,
    );
    return server.completeUpload(report.id, version);
  }
}

/**
 * Publishes the open project's report to PawpawBI: the first time, a new report; after that,
 * a new version of the same report, so its address doesn't change.
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
      const title = (await readReport(filesDir)).title;
      const hosted = await uploadVersion(
        server,
        await packSite(filesDir),
        (files) =>
          previous
            ? server.updateReport(previous.reportId, 'site', files)
            : server.createReport(title, files),
      );
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
        const hosted = await uploadVersion(
          server,
          await packData(filesDir),
          (files) => server.updateReport(report.reportId, 'data', files),
        ).catch(forgetIfSignedOut);
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
