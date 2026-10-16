// Types shared between the main process, preload script and renderer.

/** manifest.json inside a .pawpaw file. See docs/pawpaw-file-format.md. */
export interface ProjectManifest {
  formatVersion: number;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  createdWith: string;
  modifiedWith: string;
}

/** The open project, as the renderer sees it. */
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
  /** True when there are changes not yet saved to the .pawpaw file. */
  dirty: boolean;
}

/** Result of creating or opening a project: null if the user cancelled. */
export type OpenResult = { project: Project } | { error: string } | null;

export interface RecentProject {
  name: string;
  path: string;
  openedAt: string;
}

export type WorkflowStage = 'data' | 'model' | 'visuals';

export interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  createdAt: string;
}

export interface ChatState {
  stage: WorkflowStage;
  messages: ChatMessage[];
}

export interface PythonInfo {
  version: string;
  executable: string;
  dlt: string;
  pandas: string;
}

export interface PythonApi {
  info: () => Promise<PythonInfo>;
}

export interface ProjectsApi {
  listRecent: () => Promise<RecentProject[]>;
  /** Prompts for a save location and creates a new project. */
  create: () => Promise<OpenResult>;
  /** Prompts for a project file to open. */
  open: () => Promise<OpenResult>;
  /** Reopens a project from the recent list. */
  openRecent: (path: string) => Promise<OpenResult>;
  /** Saves the open project to its .pawpaw file. */
  save: () => Promise<Project>;
  /** Closes the open project, asking to save unsaved changes. Resolves false if cancelled. */
  close: () => Promise<boolean>;
  loadChat: () => Promise<ChatState>;
  appendChat: (messages: ChatMessage[], stage: WorkflowStage) => Promise<void>;
  /** Called whenever the open project changes, e.g. it gains unsaved changes. Returns an unsubscribe function. */
  onChanged: (callback: (project: Project) => void) => () => void;
}
