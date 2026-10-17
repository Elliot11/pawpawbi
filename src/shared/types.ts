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
  /** True while background work (loads, rebuilds) is running. Saving waits for it. */
  busy: boolean;
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
  /** Set when the table's SQL transform failed to re-run after loading. */
  transformError?: string;
}

/** Loaded tables come from data loads; transformed tables are built by a SQL query. */
export type TableKind = 'loaded' | 'transformed';

/** A transformed table's definition (model/transformed.json). */
export interface TransformedTable {
  name: string;
  sql: string;
  /** Tables the query reads. */
  dependsOn: string[];
  updatedAt: string;
  /** Why the last build failed, or null. */
  error: string | null;
}

export interface SaveTransformedInput {
  name: string;
  sql: string;
  /** True to create a new table; false to change an existing one's query. */
  isNew: boolean;
}

export interface RefreshAllResult {
  sourceCount: number;
  failedSources: { name: string; error: string }[];
  /** Tables whose transform or build failed. */
  failedTables: { name: string; error: string }[];
}

/** DataProgress.sourceId for progress while refreshing every source. */
export const ALL_SOURCES = '*';

export type ColumnKind =
  | 'integer'
  | 'decimal'
  | 'text'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'nested'
  | 'other';

export interface TableSchema {
  name: string;
  kind: TableKind;
  rows: number;
  /** dlt's own _dlt_* columns are left out. */
  columns: { name: string; type: string; kind: ColumnKind }[];
  /** For a loaded table: true when it has an in-place SQL transform applied. */
  transformed: boolean;
}

/** model/diagram.json: where each table sits on the Model data canvas. */
export interface ModelDiagram {
  tables: Record<string, { x: number; y: number }>;
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
  /** Columns and row counts of every loaded table (read from metadata, so it's quick). */
  describeTables: () => Promise<TableSchema[]>;
  loadDiagram: () => Promise<ModelDiagram>;
  saveDiagram: (diagram: ModelDiagram) => Promise<void>;
  /** The table's saved SQL transform, or null if it has none. */
  getTransform: (table: string) => Promise<string | null>;
  /**
   * Runs a SELECT query and returns the first rows. Saves nothing. For "loaded" (in-place
   * transforms) it reads loaded tables' original data; for "transformed" it reads every table
   * as currently shown.
   */
  previewTransform: (sql: string, kind?: TableKind) => Promise<TablePreview>;
  listTransformed: () => Promise<TransformedTable[]>;
  /** Creates or changes a transformed table and builds it. Refuses circular references. */
  saveTransformed: (input: SaveTransformedInput) => Promise<{ rows: number }>;
  /** Reloads every data source, then re-applies transforms and rebuilds transformed tables in order. */
  refreshAll: () => Promise<RefreshAllResult>;
  /** Saves the table's transform and writes its result, which then replaces the table everywhere. */
  applyTransform: (table: string, sql: string) => Promise<{ rows: number }>;
  removeTransform: (table: string) => Promise<void>;
  /** Deletes a table (and a loaded table's nested child tables). Refused while other tables read it. */
  deleteTable: (table: string) => Promise<void>;
  previewTable: (table: string, limit?: number) => Promise<TablePreview>;
  /** Shows a file or folder picker. Resolves to the chosen paths, or [] if cancelled. */
  pickPaths: (
    kind: 'file' | 'files' | 'folder',
    filters?: ConnectorField['fileFilters'],
  ) => Promise<string[]>;
  onProgress: (callback: (progress: DataProgress) => void) => () => void;
}

export interface PythonInfo {
  version: string;
  executable: string;
  dlt: string;
  duckdb: string;
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

/** A page of the report site, as listed in report/report.json. */
export interface ReportPage {
  /** A GUID (lowercase version 4 UUID). The page is report/pages/<id>.html. */
  id: string;
  title: string;
}

/** report/report.json */
export interface ReportFile {
  title: string;
  pages: ReportPage[];
}

/** A dataset: a named query whose result the report publishes as report/data/<name>.json. */
export interface Dataset {
  name: string;
  sql: string;
  /** Rows written at the last refresh. */
  rows?: number;
  refreshedAt?: string;
  /** Why the last refresh failed. */
  error?: string;
}

/** The scheme the app shows the report site from: pawpaw-report://site/<path>. */
export const REPORT_SCHEME = 'pawpaw-report';
export const REPORT_ORIGIN = `${REPORT_SCHEME}://site`;

export interface ReportApi {
  /** The report, or null if the project has none yet (projects made before reports existed). */
  get: () => Promise<ReportFile | null>;
  /** Adds the default report to a project that has none. */
  createSite: () => Promise<ReportFile>;
  createPage: (title: string) => Promise<ReportPage>;
  renamePage: (id: string, title: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  /** A page, stylesheet or script by its path in the site, e.g. "pages/<id>.html". */
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDatasets: () => Promise<Dataset[]>;
  /** Saves a dataset's query and writes its data. Rejects if the query fails. */
  saveDataset: (name: string, sql: string) => Promise<Dataset>;
  deleteDataset: (name: string) => Promise<void>;
  /** Rewrites every dataset's data from the current tables. */
  refreshDatasets: () => Promise<Dataset[]>;
  /** Asks for an empty folder and copies the site there, ready to host. Null if cancelled. */
  exportSite: () => Promise<string | null>;
  /** Called with the page shown when the preview moves to another page (e.g. a link). */
  onNavigated: (callback: (pageId: string) => void) => () => void;
}
