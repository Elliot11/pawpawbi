// Main-process side of getting data: the connector catalog, data sources saved in the open
// project (sources/<id>.json), each connector's Python environment, and running connector jobs
// with python/sidecar/runner.py. File format: docs/pawpaw-file-format.md
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { deleteSecrets, readSecrets, writeSecrets } from './credentials';
import { markProjectChanged, openProject } from './projects';
import { PYTHON_FLAGS, callPython, pythonEnv, pythonExe, pythonRoot, sidecarDir } from './python';
import { newId } from './shared/ids';
import type {
  ConnectorCatalog,
  ConnectorField,
  ConnectorInfo,
  DataProgress,
  DataSource,
  DiscoveredResource,
  LoadedTable,
  SaveSourceInput,
  TablePreview,
} from './shared/types';

const SAFE_ID = /^[a-z0-9]{1,32}$/;
const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

// ---------------------------------------------------------------------------------------------
// Connector catalog (defined in python/sidecar/connectors)

let catalogRequest: Promise<ConnectorCatalog> | null = null;

function catalog(): Promise<ConnectorCatalog> {
  catalogRequest ??= callPython<ConnectorCatalog>('catalog').catch((error) => {
    catalogRequest = null; // Retry next time.
    throw error;
  });
  return catalogRequest;
}

async function connector(id: string): Promise<ConnectorInfo> {
  const found = (await catalog()).connectors.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown connector: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Data sources in the open project

/** sources/<id>.json. Secrets are never stored here; see credentials.ts. */
interface SourceFile {
  id: string;
  type: string;
  name: string;
  options: Record<string, unknown>;
  resources: string[];
  tables: string[];
  lastLoadedAt: string | null;
}

const sourcesDir = () => path.join(openProject().filesDir, 'sources');
const rawDataDir = () => path.join(openProject().filesDir, 'data', 'raw');

function sourcePath(id: string) {
  if (!SAFE_ID.test(id)) throw new Error('Invalid data source ID.');
  return path.join(sourcesDir(), `${id}.json`);
}

async function readSource(id: string): Promise<SourceFile> {
  const source = JSON.parse(await fs.readFile(sourcePath(id), 'utf8'));
  return {
    id,
    type: String(source.type),
    name: String(source.name ?? source.type),
    options: source.options ?? {},
    resources: Array.isArray(source.resources) ? source.resources : [],
    tables: Array.isArray(source.tables) ? source.tables : [],
    lastLoadedAt: source.lastLoadedAt ?? null,
  };
}

async function writeSource(source: SourceFile) {
  await fs.mkdir(sourcesDir(), { recursive: true });
  await fs.writeFile(sourcePath(source.id), JSON.stringify(source, null, 2) + '\n');
  await markProjectChanged();
}

async function readAllSources(): Promise<SourceFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(sourcesDir());
  } catch {
    return [];
  }
  const sources: SourceFile[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !SAFE_ID.test(id)) continue;
    try {
      sources.push(await readSource(id));
    } catch {
      // Skip a damaged file rather than hide every source.
    }
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

async function toDataSource(source: SourceFile): Promise<DataSource> {
  const secrets = await readSecrets(openProject().id, source.id).catch(() => ({}));
  return { ...source, savedSecrets: Object.keys(secrets) };
}

async function saveSource(input: SaveSourceInput): Promise<DataSource> {
  const existing = input.id ? await readSource(input.id) : null;
  const info = await connector(existing?.type ?? input.type);
  const id = existing?.id ?? newId();
  const projectId = openProject().id;

  // Split the form into settings saved in the project and secrets kept on this computer.
  const options: Record<string, unknown> = {};
  const secrets = existing ? await readSecrets(projectId, id) : {};
  for (const field of info.fields) {
    const value = input.settings[field.key];
    if (field.secret) {
      // An empty secret field means "keep the saved value".
      if (typeof value === 'string' && value !== '') secrets[field.key] = value;
    } else if (value !== undefined && value !== null && value !== '') {
      options[field.key] = value;
    }
  }
  await writeSecrets(projectId, id, secrets);

  const source: SourceFile = {
    id,
    type: info.id,
    name: input.name.trim() || info.name,
    options,
    resources: existing?.resources ?? [],
    tables: existing?.tables ?? [],
    lastLoadedAt: existing?.lastLoadedAt ?? null,
  };
  await writeSource(source);
  return toDataSource(source);
}

async function removeTables(tables: string[]) {
  for (const table of tables) {
    if (!SAFE_TABLE.test(table)) continue;
    await fs.rm(path.join(rawDataDir(), table), { recursive: true, force: true, maxRetries: 5 });
  }
}

async function removeSource(id: string) {
  const source = await readSource(id);
  await removeTables(source.tables);
  await deleteSecrets(openProject().id, id);
  await fs.rm(sourcePath(id), { force: true });
  await markProjectChanged();
}

// ---------------------------------------------------------------------------------------------
// Connector environments
//
// Connectors that need extra Python packages get their own environment in
// userData/connector-envs/<connector id>, created on first use. It's layered on the bundled
// Python (--system-site-packages), so it shares dlt, pandas, etc. and only adds the connector's
// packages, pinned against python/constraints.txt so the shared ones never change version.

const installs = new Map<string, Promise<string>>();

function ensureEnvironment(info: ConnectorInfo, onProgress: (message: string) => void): Promise<string> {
  if (info.packages.length === 0) return Promise.resolve(pythonExe);
  let install = installs.get(info.id);
  if (!install) {
    install = prepareEnvironment(info, onProgress).finally(() => installs.delete(info.id));
    installs.set(info.id, install);
  }
  return install;
}

async function prepareEnvironment(info: ConnectorInfo, onProgress: (message: string) => void) {
  const envDir = path.join(app.getPath('userData'), 'connector-envs', info.id);
  const envPython =
    process.platform === 'win32'
      ? path.join(envDir, 'Scripts', 'python.exe')
      : path.join(envDir, 'bin', 'python3');
  const constraintsPath = path.join(pythonRoot, 'constraints.txt');
  const constraints = await fs.readFile(constraintsPath, 'utf8').catch(() => '');

  // Rebuild when the app's Python moves (e.g. after an update) or the pinned packages change.
  const stamp = createHash('sha256')
    .update([pythonExe, ...info.packages, constraints].join('\n'))
    .digest('hex');
  const stampPath = path.join(envDir, '.pawpaw-stamp');
  if ((await fs.readFile(stampPath, 'utf8').catch(() => '')) === stamp) return envPython;

  onProgress(`Downloading the ${info.name} connector. This only happens the first time…`);
  await fs.rm(envDir, { recursive: true, force: true, maxRetries: 5 });
  await runProcess(pythonExe, [...PYTHON_FLAGS, '-m', 'venv', '--system-site-packages', envDir]);
  await runProcess(
    envPython,
    [
      ...PYTHON_FLAGS,
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-input',
      '--no-warn-script-location',
      ...(constraints ? ['-c', constraintsPath] : []),
      ...info.packages,
    ],
    (line) => {
      const match = /^(Collecting|Downloading|Installing collected packages)\s*:?\s*(\S+)?/.exec(line);
      if (match) onProgress(`${match[1]} ${match[2] ?? ''}`.trim());
    },
  );
  await fs.writeFile(stampPath, stamp);
  return envPython;
}

/** Runs a command to completion; rejects with the end of its output if it fails. */
function runProcess(command: string, args: string[], onLine?: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { windowsHide: true, env: pythonEnv() });
    const tail: string[] = [];
    const collect = (line: string) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      onLine?.(line.trim());
    };
    readline.createInterface({ input: proc.stdout }).on('line', collect);
    readline.createInterface({ input: proc.stderr }).on('line', collect);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Downloading the connector failed:\n${tail.slice(-6).join('\n')}`));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Running connector jobs

const runningJobs = new Set<string>();

function sendProgress(progress: DataProgress) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('data:progress', progress);
}

function runJob<T>(python: string, job: Record<string, unknown>, onProgress: (message: string) => void) {
  const project = openProject();
  return new Promise<T>((resolve, reject) => {
    const proc = spawn(python, [...PYTHON_FLAGS, path.join(sidecarDir, 'runner.py')], {
      windowsHide: true,
      // Each project keeps its own dlt pipeline state.
      env: pythonEnv(path.join(app.getPath('userData'), 'dlt', project.id)),
    });
    let outcome: { ok: true; value: T } | { ok: false; error: Error } | null = null;
    const stderr: string[] = [];

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.event === 'progress') onProgress(event.message);
      else if (event.event === 'result') outcome = { ok: true, value: event.result };
      else if (event.event === 'error') {
        console.error(`[connector] ${event.detail}`);
        outcome = { ok: false, error: new Error(event.message) };
      }
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (outcome?.ok) resolve(outcome.value);
      else if (outcome) reject(outcome.error);
      else reject(new Error(`The connector stopped unexpectedly (exit code ${code}).\n${stderr.slice(-3).join('\n')}`));
    });
    // Settings (including secrets) go over stdin, never on the command line.
    proc.stdin.end(JSON.stringify(job) + '\n');
  });
}

/** Runs a job for a source, with its saved settings and secrets. */
async function runSourceJob<T>(id: string, job: Record<string, unknown>): Promise<T> {
  if (runningJobs.has(id)) throw new Error('This data source is already busy.');
  runningJobs.add(id);
  try {
    const source = await readSource(id);
    const info = await connector(source.type);
    const onProgress = (message: string) => sendProgress({ sourceId: id, message });
    const python = await ensureEnvironment(info, onProgress);
    const settings = { ...source.options, ...(await readSecrets(openProject().id, id)) };
    return await runJob<T>(python, { ...job, connector: info.id, settings }, onProgress);
  } finally {
    runningJobs.delete(id);
  }
}

async function load(id: string, resources: string[]): Promise<LoadedTable[]> {
  const others = (await readAllSources()).filter((s) => s.id !== id);
  const result = await runSourceJob<{ tables: LoadedTable[] }>(id, {
    action: 'load',
    resources,
    data_dir: path.join(openProject().filesDir, 'data'),
    pipeline_name: `pawpaw_${id}`,
    reserved_tables: others.flatMap((s) => s.tables),
  });

  // Tables this source loaded last time but no longer produces are removed.
  const source = await readSource(id);
  const tables = result.tables.map((t) => t.name);
  await removeTables(source.tables.filter((t) => !tables.includes(t)));
  await writeSource({ ...source, resources, tables, lastLoadedAt: new Date().toISOString() });
  return result.tables;
}

// ---------------------------------------------------------------------------------------------
// IPC

async function pickPaths(
  event: IpcMainInvokeEvent,
  kind: 'file' | 'files' | 'folder',
  filters: ConnectorField['fileFilters'] = [],
): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender)!;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties:
      kind === 'folder' ? ['openDirectory'] : kind === 'files' ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filters.map((f) => ({ name: f.name, extensions: f.extensions })),
  });
  return canceled ? [] : filePaths;
}

export function registerDataHandlers() {
  ipcMain.handle('data:catalog', () => catalog());
  ipcMain.handle('data:list-sources', async () => Promise.all((await readAllSources()).map(toDataSource)));
  ipcMain.handle('data:save-source', (_event, input: SaveSourceInput) => saveSource(input));
  ipcMain.handle('data:remove-source', (_event, id: string) => removeSource(id));
  ipcMain.handle('data:discover', (_event, id: string) =>
    runSourceJob<DiscoveredResource[]>(id, { action: 'discover' }),
  );
  ipcMain.handle('data:load', (_event, id: string, resources: string[]) => load(id, resources));
  ipcMain.handle('data:list-tables', () =>
    callPython<string[]>('list_tables', { data_dir: path.join(openProject().filesDir, 'data') }),
  );
  ipcMain.handle('data:preview-table', (_event, table: string, limit = 100) =>
    callPython<TablePreview>('preview_table', {
      data_dir: path.join(openProject().filesDir, 'data'),
      table,
      limit,
    }),
  );
  ipcMain.handle('data:pick-paths', pickPaths);
}
