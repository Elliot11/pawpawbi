# Design decisions

The major choices behind PawpawBI, why they were made, and what was rejected. Before reversing
one, read its reasoning; if circumstances have changed, add a new entry that supersedes it rather
than editing history. Newest last.

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

**Why:** The data tooling we wanted (dlt, and at the time pandas) is Python. Relying on the user's own Python is
fragile (missing, wrong version, missing packages). The standalone builds are what `uv` uses and
include pip.

**Alternatives:** the user's installed Python (fragile); PyInstaller-frozen executables (often
flagged by antivirus); `uv` downloading Python on first run (needs internet); Pyodide in the page
(can't open network connections, so no database drivers).

**Consequences:** about 275 MB of Python in the packaged app, mostly pyarrow, DuckDB and
SQLAlchemy plus precompiled bytecode (it was about 400 MB before pandas and numpy were removed
in decision 14). The Python files must be code-signed for release.

## 3. dlt for connecting to data

**Decision:** Use [dlt](https://dlthub.com) for all data loading: its built-in `filesystem`,
`sql_database` and `rest_api` sources, plus 27 of its "verified sources" vendored unmodified
into `python/sidecar/verified_sources/`.

**Why:** It covers the widest range of sources (files, 30+ databases, cloud storage, many SaaS
APIs) behind one programming model, and handles pagination, nested data and schemas.

**Alternatives:** DuckDB's own extensions for reading sources (considered first, then rejected in
favour of dlt plus Python); Knex or individual Node.js drivers (databases only); Airbyte, Singer or
Meltano (separate services, too heavy for a desktop app).

**Consequences:** verified sources aren't pip packages, so they're vendored from a pinned commit
and must be refreshed by hand ([maintenance.md](maintenance.md)).

## 4. Data stored as Parquet files, not loaded into a database

**Decision:** dlt writes to its `filesystem` destination as Parquet (`data/raw/<table>/`).
**No data is loaded into DuckDB** (an explicit user requirement). Originally pandas and pyarrow
read the files; since decision 14, DuckDB queries them.

**Why:** Plain files that travel inside the project, readable by many tools, compact and typed.

**Alternatives:** loading into a DuckDB database file (rejected by the user, and revisited in
decision 14); SQLite.

## 5. `.pawpaw` project files are ZIPs of ordinary files

**Decision:** A project is one ZIP archive of JSON, JSON Lines and Parquet files with a defined
layout ([pawpaw-file-format.md](pawpaw-file-format.md)). It's opened by extracting to a working
folder and saved by re-zipping atomically.

**Why:** One file to share or back up; inspectable with everyday tools; data and model travel
together; the same approach as EPUB and OpenDocument (uncompressed `mimetype` first). Working on an
extracted folder makes dlt and DuckDB easy to use, and allows crash recovery.

**Alternatives:** a single JSON file (the first version; can't hold data); a SQLite project file;
a folder instead of a file.

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

## 11. SQL transforms run by DuckDB, used only as a query engine

**Decision:** A table's transform is one SQL `SELECT` (DuckDB dialect) stored in
`model/transforms.json`. DuckDB runs it in memory over the raw Parquet files, and the result is
written to `data/model/<table>/` and used in place of the original. Queries can reference any
table, always see the original data, and are locked down (see [security.md](security.md)).

**Why:** SQL is widely known and expressive (joins, window functions, dates). DuckDB is fast on
Parquet and can be confined to the project's data folder, which matters because projects are
shared. Using it only as a query engine respects decision 4.

**Alternatives:** SQLite via pandas (no new package, but an older dialect and slow because it copies
data); Polars SQL (bigger package, less complete SQL); pandas-only step lists (the original plan
in the spec, less flexible).

**Consequences:** adds DuckDB (about 20 MB). Transforms re-run after every load of their table.

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

## 14. DuckDB as the engine for reading loaded data; pandas removed

**Decision:** Everything that reads loaded data goes through one locked-down, in-memory DuckDB
(`python/sidecar/engine.py`) over the project's Parquet files: table info, previews and SQL
transforms now, and relationships and visuals later. The file connectors read CSV with DuckDB
and Excel with openpyxl. pandas, and with it numpy, is no longer bundled. dlt stays for
connecting, and storage stays Parquet. Refines decisions 4 and 11.

**Why:** Joins, aggregations for charts and filtering are SQL-shaped work, and DuckDB does them
faster than pandas, streaming instead of loading whole tables into memory (previews used to read
an entire table to show 200 rows). One engine means one sandbox to secure. DuckDB also detects
CSV types better, so dates and numbers no longer arrive as text. Removing pandas and numpy saved
about 120 MB.

**Alternatives considered:**
- **Store the data in a DuckDB database file** inside the project. Rejected for now:
  - Only one process can write to a DuckDB file at a time, but loads run in their own processes
    while the sidecar reads.
  - A file written by a newer DuckDB may not open in an older one, which matters for shared
    projects.
  - Data would no longer be readable by other tools.
  - Opening shared projects would mean handing DuckDB a whole database file, including any
    stored views or macros.

  Worth revisiting if projects get large enough to need indexes or incremental updates.
- **Use DuckDB's extensions instead of dlt** for files and databases. They're faster for bulk
  copies, but we'd still need dlt for business apps, so we'd maintain two connector systems.
  They'd also download extensions at runtime, which the sandbox blocks on purpose. Possible later
  for specific slow cases, such as large Postgres tables.

**Consequences:**
- Processing is done in DuckDB SQL rather than pandas.
- CSV columns can get different, better types than before, which can affect SQL transforms
  written against older loads.
- Connector packages that need pandas, such as Databricks, install it into their own environment
  on first use.
