# Architecture

How PawpawBI is put together: the processes, how they talk, and how data flows from a source to
a report. For the reasons behind these choices see [decisions.md](decisions.md); for the
security side see [security.md](security.md).

## Processes

PawpawBI runs as several cooperating processes:

```mermaid
flowchart LR
  subgraph Electron
    R["Renderer<br/>Vue UI<br/>(no file or network access)"]
    P["Preload<br/>window.api"]
    M["Main process<br/>Node.js"]
  end
  S["Python sidecar<br/>main.py<br/>(long-running)"]
  J["Connector job<br/>runner.py<br/>(one per load)"]
  F[("Working folder<br/>unzipped project")]
  C[("Credentials<br/>OS-encrypted")]
  X(("Data sources<br/>files, databases, APIs"))

  R -- "window.api.*()" --> P -- "IPC invoke" --> M
  M -- "events (project changed, progress)" --> R
  M -- "JSON lines over stdin/stdout" --> S
  M -- "job JSON on stdin, events on stdout" --> J
  M <--> F
  M <--> C
  S <--> F
  J --> F
  J <--> X
```

| Process            | Code                                           | Responsibilities                                                                                                                                  |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renderer**       | `src/App.vue`, `src/views/`, `src/components/` | The whole UI. Sandboxed like a web page: no Node.js, no file system. Everything else goes through `window.api`.                                   |
| **Preload**        | `src/preload.ts`                               | Defines `window.api`: a short list of named functions, each forwarding to one IPC channel. Types in `src/shared/types.ts`.                        |
| **Main**           | `src/main.ts` and the modules below            | Owns the window, the open project, files on disk, credentials and the Python processes.                                                           |
| **Python sidecar** | `python/sidecar/main.py`                       | Started on first use, lives until the app quits. Handles quick requests: the connector catalog, table schemas and previews, SQL transforms.       |
| **Connector job**  | `python/sidecar/runner.py`                     | A fresh process for each "connect" or "load". Can be slow, can use a connector's own Python environment, and can crash without affecting the app. |

### Main-process modules

| Module              | Does                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`           | Creates the window, registers IPC handlers, asks to save on close, opens external links in the browser.                                                                                                                                                                                                                                         |
| `projects.ts`       | The open project: the dialogs for creating, opening, saving and closing, the recent list, chat history and the current workflow step.                                                                                                                                                                                                           |
| `workspace.ts`      | Working folders and crash recovery: opening a `.pawpaw` file into its working folder (offering back unsaved changes left by a crash), saving, and removing it. No Electron imports, so it's tested with plain Node.                                                                                                                             |
| `pawpaw-archive.ts` | Reading and writing `.pawpaw` ZIP files, including the safety checks on paths. No Electron imports, so it's testable with plain Node.                                                                                                                                                                                                           |
| `data.ts`           | Data sources (`sources/*.json`), connector environments, running connector jobs, table schemas and previews, the model diagram, in-place transforms and transformed tables, rebuilding them in dependency order after loads (`rebuildDerived`, `refreshAll`), and deleting tables (refused while other tables read them).                       |
| `background.ts`     | Tracks each project's background work, so saving can wait for it and closing can wait for it or stop it. No Electron imports, so it's tested with plain Node.                                                                                                                                                                                   |
| `credentials.ts`    | Encrypting and storing secrets with Electron's `safeStorage`.                                                                                                                                                                                                                                                                                   |
| `report.ts`         | The report site: serving it to the app on the `pawpaw-report:` scheme, datasets (refreshed after loads and rebuilds), export, and the network and navigation lockdown that keeps the report frame sandboxed. File handling is in `report-site.ts` (no Electron imports, tested with plain Node); a new site's files are `src/report-template/`. |
| `python.ts`         | Paths to the bundled Python, the shared flags and environment for Python processes, and the sidecar client (`callPython`).                                                                                                                                                                                                                      |

## Talking between processes

**Renderer → main.** Every call is `window.api.<area>.<method>()` → `ipcRenderer.invoke('<area>:<method>')`
→ an `ipcMain.handle` in the main process. Areas: `projects`, `data`, `report`, `python`. Values must be
plain data (wrap Vue state in `plain()`). Errors arrive as rejected promises; show them with
`errorMessage()`.

**Main → renderer.** Two event streams: `project:changed` (name, path, unsaved-changes flag) and
`data:progress` (status messages while connecting, loading or rebuilding, tagged with the source's
ID, or `ALL_SOURCES` during Refresh all data), and `report:navigated` (the report frame followed a
link to another page).

**Main → sidecar.** One JSON object per line on the sidecar's stdin:
`{"id": 1, "method": "describe_tables", "params": {...}}`, answered by one line on its stdout:
`{"id": 1, "result": ...}` or `{"id": 1, "error": "..."}`. The method table is `METHODS` in
`python/sidecar/main.py`. stdout is reserved for these replies; logging goes to stderr, which the
main process prints to its console.

**Main → connector job.** `runner.py` reads one job as JSON on stdin (including decrypted secrets,
which therefore never appear on a command line) and writes events, one per line:
`{"event": "progress", "message": ...}`, then `{"event": "result", ...}` or
`{"event": "error", "message": ..., "detail": <traceback>}`.

## Projects on disk

A `.pawpaw` file is a ZIP (format: [pawpaw-file-format.md](pawpaw-file-format.md)). The app never
edits it in place:

1. **Open:** validate the archive, then extract it to a working folder,
   `%APPDATA%\PawpawBI\workspaces\<project id>-<path hash>\project\`. A `state.json` beside it
   records which file it came from and whether there are unsaved changes.
2. **Work:** everything (data loads, transforms, chat, layout) reads and writes that folder, and
   marks the project as changed.
3. **Save:** zip the folder to a temporary file next to the original, then replace the original
   in one step.
4. **Close:** delete the working folder. If the app crashes instead, the folder survives and the
   next open offers to recover it.

**Background work** (data loads, rebuilds, connector downloads) writes into the working folder
too, so it's tracked per project (`src/background.ts`). Every data operation that changes the
project runs through `tracked()` in `data.ts`, and the processes it starts register a way to stop
them.

- **Saving** waits until the project's work has finished, so it never zips half-written tables.
- **Closing** (or quitting) with work running asks first:
  - **Wait** closes once the work finishes.
  - **Stop and close** kills the connector processes, restarts the Python sidecar and stops
    multi-step work between steps.
  - **Keep working** cancels the close.

  While closing, no new work can start.

- **Quitting** the app stops any processes still running.

Data kept outside the project file, on this computer only:

| Where (under `%APPDATA%\PawpawBI\`)  | What                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `credentials\<project>\<source>.bin` | Encrypted secrets for each data source                      |
| `connector-envs\<connector>\`        | Python environments for connectors that need extra packages |
| `dlt\<project>\`                     | dlt's local pipeline state                                  |
| `recent-projects.json`               | The start screen's recent list                              |
| `workspaces\`                        | Working folders of open (or crashed) projects               |

## Data flow

```mermaid
flowchart LR
  SRC["Data source"] -->|"connector + dlt<br/>(runner.py)"| RAW["data/raw/&lt;table&gt;/*.parquet"]
  RAW -->|"in-place transform<br/>(DuckDB)"| MOD["data/model/&lt;table&gt;/data.parquet"]
  RAW -->|"no transform"| CUR(("Tables as shown"))
  MOD --> CUR
  CUR -->|"transformed table<br/>(DuckDB, in dependency order)"| TR["data/transformed/&lt;table&gt;/data.parquet"]
  TR --> CUR
  CUR --> USE["Model view, previews"]
  CUR -->|"datasets<br/>(DuckDB)"| SITE["report/data/&lt;dataset&gt;.json"]
  SITE --> WEB["The report site:<br/>in the app, or hosted"]
```

1. **Connect.** The user picks a connector in the Add data screen. Its form comes from the
   catalog (`python/sidecar/connectors/`). Saving writes non-secret settings to
   `sources/<id>.json` and secrets to the credential store.
2. **Discover.** A connector job builds the dlt source (`Connector.build(settings)`) and lists its
   resources, i.e. the tables it can load. For databases this is also the connection test.
3. **Load.** A connector job runs a dlt pipeline into the project's `data/` folder using dlt's
   `filesystem` destination, writing Parquet into `data/raw/<table>/`. Every load is a full refresh.
   Nested data becomes child tables named `parent__child`.
4. **Transform** (optional). There are two kinds of SQL, both run by DuckDB:
   - **In-place transforms** of loaded tables read the original Parquet files and write to
     `data/model/<table>/`, which replaces the loaded table everywhere.
   - **Transformed tables** read any other tables as currently shown and write to
     `data/transformed/<table>/`.

   After each load, every in-place transform is re-applied, then transformed tables are rebuilt in
   dependency order (each after the transformed tables it reads). The order and cycle checks are
   in `src/shared/dependencies.ts`, and the orchestration is in `data.ts` (`rebuildDerived`).

5. **Use.** The Model view and previews read schemas and rows through the sidecar.
6. **Publish.** Datasets (named queries) are run after each load or rebuild and their results
   written as JSON into the report site (`report/data/`), which the report's pages read. The site
   is shown in the app and can be exported as a folder to host anywhere.

## The query engine

All reading of loaded data goes through `python/sidecar/engine.py`. For each request it opens a
fresh in-memory DuckDB, creates one view per table over that table's Parquet files, and locks
the connection down (see [security.md](security.md)). Nothing is stored in DuckDB.

There are two views of the data:

- **`current`** (previews, table info and transformed tables): every table as the app shows it,
  meaning loaded tables (with their in-place transform applied, if any) and transformed tables.
- **`raw`** (in-place transforms): loaded tables' original data only, so in-place transforms never
  build on each other.

dlt's `_dlt_*` bookkeeping columns are left out of the views. Values are converted to JSON-safe
ones (`engine.json_value`) before going to the UI.

## Connector environments

Connectors that need extra Python packages declare them in their catalog entry (`packages`). The
first time one is used, `data.ts` creates `connector-envs\<connector id>\` with
`python -m venv --system-site-packages --without-pip` layered on the bundled Python. It shares
dlt, DuckDB, pip and the rest, and adds only the connector's packages. They're installed with
`python/constraints.txt` as constraints, so shared packages never change version, and with
`--uploaded-prior-to P14D`, so only releases at least 14 days old are used. A stamp file records the Python path,
packages and constraints, and the environment is rebuilt whenever any of them change (e.g. after
an app update moves the Python install). That connector's jobs then run with that environment's
Python.

## The UI

`App.vue` shows the start screen (`views/SplashScreen.vue`) or an open project
(`views/ProjectWorkspace.vue`). In a project:

- **Top bar:** back to projects, the project name, the workflow steps (`WorkflowSteps.vue`), and Save.
- **Left:** the assistant chat (`ChatPanel.vue`). Its replies are placeholders in `src/workflow.ts`
  until an AI model is connected.
- **Main area:** follows the workflow step. **Add data** is `components/data/GetData.vue` (the
  connector gallery, source setup and table previews). **Model data** is `ModelData.vue`, the
  draggable table canvas: cards for loaded tables (orange) and transformed tables (purple),
  dependency arrows on its SVG layer, a legend, and Refresh all data. It opens
  `TransformEditor.vue` for SQL: a loaded table's in-place transform, or a new or existing
  transformed table. **Build visuals** is `ReportCanvas.vue`: a tab per report page, the page shown in a
  sandboxed frame from `pawpaw-report://site/<path>`, and a side panel to edit the site's files
  or its datasets (`report/DatasetsPanel.vue`). Export copies the site to a folder. The report
  itself is plain HTML, CSS and JavaScript ([report-pages.md](report-pages.md)); no Vue.

The current workflow step is saved with the project (`chat/session.json`).

## Build and packaging

Electron Forge with Vite (`forge.config.mts`) builds three bundles, for the main process, preload
and renderer, into `.vite/`. Packaging copies the `python/` folder (runtime, sidecar, lock file) and
the window icon in as extra resources, so in the packaged app Python lives at
`resources\python\`. `src/python.ts` picks the right location for development or packaged runs.
The `prestart`, `prepackage` and `premake` scripts make sure the Python runtime exists first.
