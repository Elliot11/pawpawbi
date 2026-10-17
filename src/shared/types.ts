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

// --- Data connectors (python/sidecar/connectors) --------------------------------------------

export type ConnectorFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'files'
  | 'folder';

export interface ConnectorField {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required: boolean;
  /** Stored encrypted on this computer, never in the project file. */
  secret: boolean;
  help: string;
  placeholder: string;
  default: unknown;
  options: { value: string; label: string }[];
  fileFilters: { name: string; extensions: string[] }[];
  advanced: boolean;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: ConnectorField[];
  /** Python packages downloaded the first time the connector is used. */
  packages: string[];
  docsUrl: string;
  keywords: string[];
}

export interface ConnectorCatalog {
  categories: string[];
  connectors: ConnectorInfo[];
}

/** A configured data source: sources/<id>.json in the project, plus which secrets are saved. */
export interface DataSource {
  id: string;
  /** Connector ID. */
  type: string;
  name: string;
  /** Non-secret settings. */
  options: Record<string, unknown>;
  /** Resources the user chose to load; empty means the connector's defaults. */
  resources: string[];
  tables: string[];
  lastLoadedAt: string | null;
  /** Keys of secret fields that have a saved value on this computer. */
  savedSecrets: string[];
}

export interface SaveSourceInput {
  /** Omit to create a new source. */
  id?: string;
  type: string;
  name: string;
  /** All field values. Secret fields left empty keep their saved value. */
  settings: Record<string, unknown>;
}

export interface DiscoveredResource {
  name: string;
  selected: boolean;
}

export interface LoadedTable {
  name: string;
  rows: number;
}

export interface TablePreview {
  columns: { name: string; dtype: string }[];
  rows: unknown[][];
  row_count: number;
}

export interface DataProgress {
  sourceId: string;
  message: string;
}

export interface DataApi {
  catalog: () => Promise<ConnectorCatalog>;
  listSources: () => Promise<DataSource[]>;
  saveSource: (input: SaveSourceInput) => Promise<DataSource>;
  /** Removes the source, its saved credentials and its tables. */
  removeSource: (id: string) => Promise<void>;
  /** Connects and lists the tables the source can load. Downloads the connector first if needed. */
  discover: (id: string) => Promise<DiscoveredResource[]>;
  /** Loads the chosen resources (a full refresh) into the project. */
  load: (id: string, resources: string[]) => Promise<LoadedTable[]>;
  listTables: () => Promise<string[]>;
  previewTable: (table: string, limit?: number) => Promise<TablePreview>;
  /** Shows a file or folder picker. Resolves to the chosen paths, or [] if cancelled. */
  pickPaths: (kind: 'file' | 'files' | 'folder', filters?: ConnectorField['fileFilters']) => Promise<string[]>;
  onProgress: (callback: (progress: DataProgress) => void) => () => void;
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
  /** Moves the workflow to a step (saved in chat/session.json). */
  setStage: (stage: WorkflowStage) => Promise<void>;
  /** Called whenever the open project changes, e.g. it gains unsaved changes. Returns an unsubscribe function. */
  onChanged: (callback: (project: Project) => void) => () => void;
}
