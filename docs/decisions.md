# Design decisions

The major choices behind PawpawBI, why they were made, and what was rejected. Read an entry's
reasoning before changing what it covers. This describes the current design only: when a
decision changes, edit its entry in place rather than adding history.

Each entry: **Decision**, **Why**, **Alternatives considered**, and **Consequences** where useful.

---

## 1. Electron Forge, Vite, TypeScript and Vue

**Decision:** Electron app scaffolded with Electron Forge's Vite + TypeScript template; Vue 3 for
the UI.

**Why:** Forge is Electron's official tooling and handles packaging, installers and signing.
Vite gives fast reloads. Vue was the user's choice of UI framework.

**Alternatives:** electron-vite (community; uses electron-builder); a plain JavaScript setup;
React or Svelte for the UI.

## 2. A bundled, portable Python

**Decision:** Ship a portable CPython 3.12 from
[python-build-standalone](https://github.com/astral-sh/python-build-standalone) inside the app,
pinned by release and SHA-256. Use the "stripped" builds. The main process talks to it over
stdin/stdout.

**Why:** The data tooling (dlt and its connectors) is Python. Relying on the user's own Python is
fragile (missing, wrong version, missing packages). The standalone builds are what `uv` uses and
include pip.

**Alternatives:** the user's installed Python (fragile); PyInstaller-frozen executables (often
flagged by antivirus); `uv` downloading Python on first run (needs internet); Pyodide in the page
(can't open network connections, so no database drivers).

**Consequences:** about 275 MB of Python in the packaged app, mostly pyarrow, DuckDB and
SQLAlchemy plus precompiled bytecode. The Python files must be code-signed for release.

## 3. dlt for connecting to data

**Decision:** Use [dlt](https://dlthub.com) for all data loading: its built-in `filesystem`,
`sql_database` and `rest_api` sources, plus 27 of its "verified sources" vendored unmodified
into `python/sidecar/verified_sources/`.

**Why:** It covers the widest range of sources (files, 30+ databases, cloud storage, many SaaS
APIs) behind one programming model, and handles pagination, nested data and schemas.

**Alternatives:**

- **DuckDB's own extensions** for files and databases. They're faster for bulk copies, but we'd
  still need dlt for business apps, so we'd maintain two connector systems. They'd also download
  extensions at runtime, which the query sandbox blocks on purpose. Worth considering for specific
  slow cases, such as large Postgres tables.
- **Knex or individual Node.js drivers:** databases only.
- **Airbyte, Singer or Meltano:** separate services, too heavy for a desktop app.

**Consequences:** verified sources aren't pip packages, so they're vendored from a pinned commit
and must be refreshed by hand ([maintenance.md](maintenance.md)).

## 4. Parquet files for storage, DuckDB as the query engine

**Decision:** dlt writes loaded data to its `filesystem` destination as Parquet
(`data/raw/<table>/`). **No data is loaded into DuckDB** (an explicit user requirement).
Everything that reads loaded data goes through one locked-down, in-memory DuckDB over those files
(`python/sidecar/engine.py`): table info and previews, SQL transforms, and later relationships and
visuals. The file connectors read CSV with DuckDB and Excel with openpyxl. pandas isn't used.

**Why:**

- **Parquet storage:** plain files that travel inside the project, readable by many tools, compact
  and typed.
- **DuckDB querying:** joins, aggregations for charts and filtering are SQL-shaped work, and DuckDB
  does them fast, streaming rather than loading whole tables into memory. A preview reads only the
  rows it shows.
- **One engine, one sandbox:** a single place to lock down, which matters because projects are
  shared ([security.md](security.md)).
- **Better CSV reading:** DuckDB detects CSV types, so dates and numbers don't arrive as text.
- **Smaller app:** without pandas and numpy, the bundle is about 120 MB smaller.

**Alternatives:**

- **Store the data in a DuckDB database file** inside the project.
  - Only one process can write to a DuckDB file at a time, but loads run in their own processes
    while the sidecar reads.
  - A file written by a newer DuckDB may not open in an older one, which matters for shared
    projects.
  - Data would no longer be readable by other tools.
  - Opening shared projects would mean handing DuckDB a whole database file, including any stored
    views or macros.

  Worth reconsidering if projects get large enough to need indexes or incremental updates.

- **pandas for reading and processing:** slower, loads whole tables into memory, and adds about
  120 MB.
- **SQLite:** an older SQL dialect and slow on analytical queries.

**Consequences:** connector packages that need pandas, such as Databricks, install it into their
own environment on first use.

## 5. `.pawpaw` project files are ZIPs of ordinary files

**Decision:** A project is one ZIP archive of JSON, JSON Lines and Parquet files with a defined
layout ([pawpaw-file-format.md](pawpaw-file-format.md)). It's opened by extracting to a working
folder and saved by re-zipping atomically.

**Why:** One file to share or back up; inspectable with everyday tools; data and model travel
together; the same approach as EPUB and OpenDocument (uncompressed `mimetype` first). Working on an
extracted folder makes dlt and DuckDB easy to use, and allows crash recovery.

**Alternatives:** a single JSON file (can't hold data); a SQLite project file; a folder instead of
a file.

**Consequences:** opening and saving large projects copies all the data. Unknown files are kept
on save so newer versions can add files without breaking older ones.

## 6. Secrets in OS-encrypted storage, never in the project

**Decision:** Connector fields marked secret are encrypted with Electron's `safeStorage` (DPAPI on
Windows) and kept per project and source on the user's computer.

**Why:** Project files are shared; credentials must not travel with them.

**Consequences:** opening a project on another computer requires signing in again before
refreshing sources.

## 7. Connector packages installed on first use, in separate environments

**Decision:** The installer bundles only core packages. A connector's extra packages (database
drivers, SaaS SDKs) are pip-installed the first time it's used, into its own virtual environment
layered on the bundled Python and constrained by `python/constraints.txt`.

**Why:** Bundling every connector's packages would add roughly 250–400 MB and some pin conflicting
versions of shared libraries. Separate environments keep connectors from breaking each other.

**Alternatives:** bundle everything (works offline, much bigger, version clashes); ship only core
connectors.

**Consequences:** first use of such a connector needs internet. Environments are rebuilt when the
app's Python path or the pins change. Per-connector transitive versions aren't locked yet
([TODO.md](../TODO.md)).

## 8. Each connector job in its own process

**Decision:** "Connect" and "load" run `runner.py` as a new process; the long-running sidecar
only handles quick requests.

**Why:** Loads can be slow, can need a connector's own environment, and can crash or leak memory.
A separate process isolates all of that.

## 9. Full refresh on every load

**Decision:** Every load replaces its tables (`write_disposition="replace"`) and resets dlt's
incremental state (`refresh="drop_resources"`).

**Why:** Simple and predictable. dlt's `filesystem` destination doesn't support merging without
Delta or Iceberg tables. Incremental cursors combined with replace would silently drop older rows.

**Consequences:** large sources reload everything each time ([TODO.md](../TODO.md)).

## 10. The workflow step drives the main screen

**Decision:** The top bar's steps (Add data → Model data → Build visuals) are the navigation; there
are no separate tabs. The current step is saved with the project.

**Why:** The app is organised around that guided workflow; tabs duplicated it.

## 11. Two kinds of table, both shaped with SQL

**Decision:** There are two kinds of table, and both are shaped with a single SQL `SELECT` (DuckDB
dialect) run in the locked-down query engine (decision 4):

- **Loaded tables** come from data loads. A loaded table can have an **in-place transform**
  (`model/transforms.json`) that changes how it looks. That query reads loaded tables' original
  data, and the result replaces the table everywhere.
- **Transformed tables** (`model/transformed.json`) are new tables built from any other tables,
  loaded or transformed, so they can combine and reshape data across tables.

The tables each query reads are worked out when it's saved and kept as `dependsOn`, using sqlglot.
DuckDB's own `get_table_names` resolves views to the files behind them, so it can't be used.

- **No circular references:** saving a query that would create one is refused.
- **Rebuild order:** after any load, every in-place transform is re-applied, then transformed
  tables are rebuilt in dependency order (`src/shared/dependencies.ts`).
- **Safe deletes:** tables that others read can't be deleted.

**Why:**

- **SQL:** widely known and expressive (joins, window functions, dates), and DuckDB runs it fast
  while staying confined to the project's data folder.
- **Separate transformed tables:** they keep combining data separate from the loaded tables, and
  can build on each other.
- **In-place transforms:** quick fixes to a loaded table (types, renames) without making a new
  table. Both were wanted.

**Alternatives:**

- **Only transformed tables:** simpler, with one concept instead of two, but rejected because
  quick in-place fixes were wanted.
- **SQLite via pandas:** an older dialect, and slow because it copies data.
- **Polars SQL:** a bigger package with less complete SQL.
- **A fixed list of step types** such as filter, rename and join: less flexible.

**Consequences:**

- Every load rebuilds all transforms and transformed tables. That's simple and always correct,
  but slower for large models.
- Better type detection in a reload can change column types, which can affect a query.
- The UI calls loaded tables with an in-place transform "Transformed" on their button, which is
  close to the name of the other kind.

## 12. Model view as a free-form canvas

**Decision:** Model data is a pannable, zoomable canvas of draggable table cards, with positions
saved in `model/diagram.json`.

**Why:** Lays the groundwork for an entity relationship diagram: relationship lines will be drawn
on the SVG layer under the cards, attached to column rows (`data-table`, `data-column`).

## 13. Dependencies pinned and at least 14 days old

**Decision:** Every dependency (npm, PyPI, connector packages, the Python build, vendored source
commit) is pinned to an exact version that has been public for at least two weeks.

**Why:** Reproducible builds, and a buffer against compromised or broken releases, which are
usually caught and pulled within days.

## 14. The report is a static website

**Decision:** A project's report (`report/`) is a self-contained static website of plain HTML, CSS
and JavaScript: a landing page, one HTML file per page, a stylesheet, our own chart library
(`assets/charts.js`, plain JavaScript drawing SVG) and the data it shows as JSON files
(decision 15). It doesn't depend on PawpawBI or anything outside the folder, so it can be hosted
as-is, for example on S3 behind a CDN. No Vue or other framework is used in it. Each page is
`report/pages/<id>.html`, where `<id>` is the page's GUID: a lowercase version 4 UUID such as
`3f2b8c1e-9a4d-4e7b-b6c2-5d1e8f0a7c94`, generated when the page is created and never changed.
Renaming a page changes only its title. Every new project starts with a default report to
build on. The app shows the site in a sandboxed frame and exports it as a folder. Details:
[pawpaw-file-format.md](pawpaw-file-format.md), [report-pages.md](report-pages.md).

**Why:** Reports have to be publishable as ordinary web files. HTML is also what an AI model
writes best, so the assistant can build any layout or chart without the app first having to
support it in a settings format, and a page stays readable and editable by hand. Our own chart
code (bars, lines, headline numbers, tables) avoids a dependency inside every report and lets
every chart follow the same rules: a colour-blind safe palette in a fixed order, at most eight
series, a table view, hover and keyboard tooltips. GUIDs keep page IDs unique when pages are
copied between reports, and stable when pages are renamed.

**Alternatives considered:**

- Pages described in JSON (chart type, columns, position) and drawn by the app: safer by
  construction, but not hostable without a viewer, every new chart or layout needs app changes,
  and an AI is limited to what the format can say.
- A charting library (ECharts, Vega-Lite, Chart.js): more chart types sooner, but a large
  dependency inside every report, and its own look and accessibility to work around.
- Pages that query the data live: impossible on a static host.

**Consequences:**

- Projects contain code (the pages' JavaScript) that runs when the report is shown. In the app
  it's contained by a sandboxed frame, a strict Content Security Policy and a block on all web
  requests, so a page can only show the report's own files ([security.md](security.md)).
- Each project carries its own copy of `charts.js`, so updating the library in the app doesn't
  change existing reports. A way to update a report's copy is still to come.
- New chart types are added to the library, and [report-pages.md](report-pages.md) is its
  contract with page authors (people and the assistant).

## 15. Report data is published as precomputed JSON datasets

**Decision:** The report reads its data from datasets: named SELECT queries over the project's
tables (`model/datasets.json`). The app runs each query in the locked-down DuckDB engine and
writes the result to `report/data/<name>.json`, after every data load or rebuild, from the
Refresh button and before exporting. Pages load datasets by name.

**Why:** A static site can't run queries, so the data has to travel with it. Writing only query
results means a report publishes what its charts need (usually small, grouped data), never the
raw tables. Keeping the queries outside `report/` keeps them out of the published site.

**Alternatives considered:** publishing the tables as Parquet and querying them in the browser
with DuckDB-WASM: flexible (filters, drill-down), but several megabytes of engine in every report
and the full raw data published.

**Consequences:**

- Charts can only show what a dataset contains. Interactive filtering happens in the page, over a
  dataset's rows.
- A hosted report is a snapshot from when it was exported.
- Datasets are capped (50,000 rows, 10 MB), which pushes grouping into SQL.
- Datasets refer to tables and columns by name, so renaming or deleting them makes the dataset's
  next refresh fail; its previous data is kept and the error shown.

## 16. The assistant works with the user's own OpenAI or Anthropic key, or Ollama locally

**Decision:** The assistant runs on ChatGPT (OpenAI) or Claude (Anthropic) with an API key the
user provides, or on a model running in Ollama on the user's computer, which needs no key and
keeps everything local. Keys are stored with OS encryption and never put in a project
or in the model's context. The conversation, tools and guides are written once, provider-neutral;
a small adapter per provider translates tool calls and streaming. The adapters call the APIs
with plain HTTPS from the main process rather than the providers' SDKs. Details:
[assistant.md](assistant.md).

**Why:** Users already have accounts with one or the other, and it avoids running a PawpawBI
service. Ollama is for people who don't want their data sent anywhere, or don't have a key. Keeping the prompts and tools neutral means both providers get the same abilities, and
the same evaluation tasks can check both. Without SDKs there are no dependencies to pin and
update, and the parts used (streamed messages with tool calls) are small and stable.

**Alternatives considered:** driving the user's own Claude Code install (`claude -p`) with their Claude subscription.

**Consequences:** Each provider's tool-calling format has to be kept working by us; adapter
tests use streams in each API's documented format. Local models are much less capable, so
prompts and tools must also work acceptably with them. Without a key, the assistant explains how to add one and the rest of the app
works by hand.

## 17. The assistant's changes are approved by the user and can always be undone

**Decision:** Every change the assistant makes is shown in the chat and recorded first, so it can
be undone: Undo on a change reverts it and every later one ("undo back to here"). By default the
user is asked before each change (Allow, Allow all changes, Don't allow); they can switch to
changes without asking, and back, in Assistant settings. Details: [assistant.md](assistant.md).

**Why:** The assistant acts on the user's project, and projects can contain content written to
steer it. Asking by default keeps the user in control until they trust it; letting them turn
asking off keeps it fast once they do. Undo back to a point, rather than undoing changes one by
one, always leaves the project consistent, e.g. never a page using a dataset that was undone.

**Alternatives considered:** asking only for deletions and outside connections (the user chose
to decide for themselves); undoing each change on its own (can leave the project inconsistent).

**Consequences:** Every change tool declares the files it may touch, so they can be copied before
it runs. Undo history lasts while the project is open (it survives a crash, but isn't saved in
the project file). Changes that can't be undone, such as loading data, must say so before they
run.
