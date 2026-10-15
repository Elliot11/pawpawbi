// Types shared between the main process, preload script and renderer.

/** The contents of a .pawpaw project file on disk. */
export interface ProjectFile {
  version: 1;
  name: string;
  createdAt: string;
}

/** A project that has been loaded, along with where it lives on disk. */
export interface Project extends ProjectFile {
  path: string;
}

export interface RecentProject {
  name: string;
  path: string;
  openedAt: string;
}

export interface ProjectsApi {
  listRecent: () => Promise<RecentProject[]>;
  /** Prompts for a save location and creates a new project. Resolves null if cancelled. */
  create: () => Promise<Project | null>;
  /** Prompts for a project file to open. Resolves null if cancelled. */
  open: () => Promise<Project | null>;
  /** Reopens a project from the recent list. Resolves null if the file is gone. */
  openRecent: (path: string) => Promise<Project | null>;
}
