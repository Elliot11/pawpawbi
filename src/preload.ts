// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Project, ProjectsApi, PythonApi } from './shared/types';

const projects: ProjectsApi = {
  listRecent: () => ipcRenderer.invoke('projects:list-recent'),
  create: () => ipcRenderer.invoke('projects:create'),
  open: () => ipcRenderer.invoke('projects:open'),
  openRecent: (path) => ipcRenderer.invoke('projects:open-recent', path),
  save: () => ipcRenderer.invoke('projects:save'),
  close: () => ipcRenderer.invoke('projects:close'),
  loadChat: () => ipcRenderer.invoke('projects:load-chat'),
  appendChat: (messages, stage) => ipcRenderer.invoke('projects:append-chat', messages, stage),
  onChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, project: Project) => callback(project);
    ipcRenderer.on('project:changed', listener);
    return () => ipcRenderer.removeListener('project:changed', listener);
  },
};

const python: PythonApi = {
  info: () => ipcRenderer.invoke('python:info'),
};

// Expose a small, explicit API to the renderer (available as window.api).
contextBridge.exposeInMainWorld('api', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  projects,
  python,
});
