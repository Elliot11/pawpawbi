// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DataApi, DataProgress, Project, ProjectsApi, PythonApi } from './shared/types';

const projects: ProjectsApi = {
  listRecent: () => ipcRenderer.invoke('projects:list-recent'),
  create: () => ipcRenderer.invoke('projects:create'),
  open: () => ipcRenderer.invoke('projects:open'),
  openRecent: (path) => ipcRenderer.invoke('projects:open-recent', path),
  save: () => ipcRenderer.invoke('projects:save'),
  close: () => ipcRenderer.invoke('projects:close'),
  loadChat: () => ipcRenderer.invoke('projects:load-chat'),
  appendChat: (messages, stage) => ipcRenderer.invoke('projects:append-chat', messages, stage),
  setStage: (stage) => ipcRenderer.invoke('projects:set-stage', stage),
  onChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, project: Project) => callback(project);
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.removeListener('project:changed', listener);
  },
};

const data: DataApi = {
  catalog: () => ipcRenderer.invoke('data:catalog'),
  listSources: () => ipcRenderer.invoke('data:list-sources'),
  saveSource: (input) => ipcRenderer.invoke('data:save-source', input),
  removeSource: (id) => ipcRenderer.invoke('data:remove-source', id),
  discover: (id) => ipcRenderer.invoke('data:discover', id),
  load: (id, resources) => ipcRenderer.invoke('data:load', id, resources),
  listTables: () => ipcRenderer.invoke('data:list-tables'),
  describeTables: () => ipcRenderer.invoke('data:describe-tables'),
  loadDiagram: () => ipcRenderer.invoke('data:load-diagram'),
  saveDiagram: (diagram) => ipcRenderer.invoke('data:save-diagram', diagram),
  getTransform: (table) => ipcRenderer.invoke('data:get-transform', table),
  previewTransform: (sql, kind) => ipcRenderer.invoke('data:preview-transform', sql, kind),
  listTransformed: () => ipcRenderer.invoke('data:list-transformed'),
  saveTransformed: (input) => ipcRenderer.invoke('data:save-transformed', input),
  refreshAll: () => ipcRenderer.invoke('data:refresh-all'),
  applyTransform: (table, sql) => ipcRenderer.invoke('data:apply-transform', table, sql),
  removeTransform: (table) => ipcRenderer.invoke('data:remove-transform', table),
  deleteTable: (table) => ipcRenderer.invoke('data:delete-table', table),
  previewTable: (table, limit) => ipcRenderer.invoke('data:preview-table', table, limit),
  pickPaths: (kind, filters) => ipcRenderer.invoke('data:pick-paths', kind, filters),
  onProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, progress: DataProgress) => callback(progress);
    ipcRenderer.on('data:progress', listener);
    return () => ipcRenderer.removeListener('data:progress', listener);
  },
};

const python: PythonApi = {
  info: () => ipcRenderer.invoke('python:info'),
};

// Expose a small, explicit API to the renderer (available as window.api).
contextBridge.exposeInMainWorld('api', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  projects,
  data,
  python,
});
