// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';
import type { ProjectsApi } from './shared/types';

const projects: ProjectsApi = {
  listRecent: () => ipcRenderer.invoke('projects:list-recent'),
  create: () => ipcRenderer.invoke('projects:create'),
  open: () => ipcRenderer.invoke('projects:open'),
  openRecent: (path) => ipcRenderer.invoke('projects:open-recent', path),
};

// Expose a small, explicit API to the renderer (available as window.api).
contextBridge.exposeInMainWorld('api', {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  projects,
});
