# Security model

What PawpawBI protects, how, and what to check before changing related code. If a change touches
anything listed under "Rules" in a section below, re-read that section and run `npm test`.

## What we're defending against

1. **A malicious `.pawpaw` file.** Projects are meant to be shared, so opening one must be safe
   even if someone crafted it to attack the person opening it. The file must not be able to
   write outside its working folder, read the user's other files, reach the network, run code,
   or obtain the user's credentials.
2. **Credential leaks.** Passwords, API keys and tokens for data sources must not end up in
   project files, logs, command lines or the UI after they're saved.
3. **A compromised page.** If something injected script into the renderer (say, via a bug that
   rendered untrusted HTML), it should get as little power as possible.
4. **A hostile report.** The report (`report/`) is HTML and JavaScript stored in the project, so a
   shared project can contain pages written to attack whoever opens it. They must not be able to
   reach the app, the user's files, credentials or the network, or send the project's data
   anywhere.
5. **Tampered downloads.** The app downloads Python, Python packages and connectors; these must
   be the expected files.

Out of scope: someone who already controls the user's Windows account, and the security of the
data sources themselves.

## Opening project files

- **Paths inside the archive.** `src/pawpaw-archive.ts` refuses the whole file if any entry has an
  absolute path, a drive letter, a backslash, or a `..` segment, or would resolve outside the
  working folder ("zip slip"). yauzl also rejects most of these (`strictFileNames`); our check is a
  second layer.
- **Identifying the file.** The first entry must be `mimetype` with the exact PawpawBI value;
  anything else is rejected before extraction.
- **IDs and names used in paths.** The project ID (`manifest.json`) must be lowercase letters and
  digits only (`parseManifest`). Source IDs (`SAFE_ID`) and table names (`SAFE_TABLE`) are
  checked before any path is built from them (`data.ts`, `credentials.ts`).
- **Newer formats.** A file with a higher `formatVersion` is refused rather than half-understood.
- **Stored dependencies.** `dependsOn` in `model/transformed.json` is only used to order rebuilds.
  A tampered file can at worst produce a wrong order or a cycle; cycles are detected
  (`buildOrder`) and those tables fail with an error instead of looping. When a query is saved in
  the app, its dependencies are recomputed from the SQL rather than trusted.
- **Saving.** Writes go to a temporary file that then replaces the original, so a failed save
  can't corrupt the project.

**Rules:** never build a path from a value read out of a project without validating it first.
Never add a feature that executes code stored in a project, other than the report in its
sandbox (below); anything else must ask the user first.

## SQL transforms and the query engine

A project can contain SQL (`model/transforms.json`), which runs when the project is used. This is
the largest attack surface. All reading of loaded data (transforms, previews, table info) goes
through one DuckDB setup, `python/sidecar/engine.py`, which locks it down:

- **One read-only statement.** `engine.select()` uses DuckDB's own parser (`extract_statements`)
  and allows exactly one statement of type `SELECT`. `COPY`, `ATTACH`, `INSTALL`, `SET`, `PRAGMA`,
  `CREATE` and the rest are refused, as are multiple statements.
- **No file system beyond the project's data.** After creating one view per table,
  `engine.connect()` sets `allowed_directories` to the project's `data/` folder and
  `enable_external_access = false`.
  Functions such as `read_csv('C:/…')` and `read_text(…)` fail for any other path, and web URLs fail.
  `temp_directory` is cleared first, because DuckDB otherwise silently adds its temp folder
  (`<working dir>/.tmp`) to the allowed directories; the automated tests caught that. As a
  result, queries can't spill to disk.
- **No extensions.** Automatic installing and loading of DuckDB extensions are off.
- **Settings locked.** `lock_configuration = true`, so a query can't undo any of the above.
- **In memory only.** Each query gets a fresh in-memory DuckDB, which is closed afterwards.

These are covered by the sandbox tests in `python/tests/` (system files, other files in the
project folder, web requests, settings, `COPY`, `DROP`, `INSTALL`, multiple statements).

**Rules:** don't create the views after locking, don't widen `allowed_directories`, don't enable
extensions, don't read project data through any other DuckDB connection than `engine.connect()`,
and don't run user SQL through any path other than `engine.select()`. When upgrading DuckDB, run
the sandbox tests: setting names and behaviour can change between versions.

(The file connectors also use DuckDB, to read CSV files the user chose. That's a separate, normal
connection inside a connector job; it never sees SQL from a project.)

## The report

The report (`report/`) is the one kind of stored code that runs: its pages' JavaScript runs
whenever Build visuals shows them, without asking, because they can only show the report's own
files. Each layer below stops something on its own:

- **Sandboxed frame.** Pages are shown in an `<iframe sandbox="allow-scripts">`
  (`ReportCanvas.vue`). Without `allow-same-origin` they have an opaque origin, so they can't
  touch the app's page, `window.api`, storage or cookies. Without the other sandbox flags they
  can't open windows, submit forms, show dialogs or navigate the app.
- **Own scheme, own files only.** The site is served from `pawpaw-report://site/<path>` by
  `src/report.ts`. `sitePath` (`report-site.ts`) refuses `..`, backslashes, hidden files and
  unknown file types, and resolves only inside the open project's `report/` folder.
- **Content Security Policy** (`SITE_CSP` in `report.ts`): scripts, styles, images, fonts and
  fetches from `pawpaw-report://site` only (plus inline scripts and styles, and `data:` images and
  fonts). No frames, workers, plugins or forms. DNS prefetching is off, so links can't leak data
  through look-ups.
- **No web requests at all.** The app's UI needs none (it's bundled files, plus the dev server
  during development; connectors use the network from Python). `lockDownNetwork()` cancels every
  `http(s)` and `ws(s)` request from the app's windows and points them at an unreachable proxy.
  The window's WebRTC policy allows only proxied connections, so WebRTC, which bypasses both the
  policy and request blocking, can't connect either.
- **No navigating away.** `guardFrames()` lets the frame move only between the site's own pages,
  so a page can't send data out in a URL.
- **No queries from pages.** Pages read only the dataset files. Dataset queries are stored in
  `model/datasets.json`, outside the site, and run through `engine.select()` in the locked-down
  engine like every other query, capped at 50,000 rows, 10 MB and 60 seconds.
- **Escaping.** `charts.js` inserts every name and value with `textContent`.

A hostile page can still show misleading content inside its frame.

**Rules:** never add `allow-same-origin`, `allow-popups`, `allow-top-navigation` or
`allow-forms` to the frame; never loosen `SITE_CSP` or `sitePath`; don't add web requests to the
renderer (they'd have to be let through `lockDownNetwork`); never give pages a way to run
queries. Covered by `tests/node/report-site.test.ts` and `python/tests/test_report_data.py`; the
frame, policy and network lockdown were checked by hand with a hostile page.

Once exported and hosted, the report is an ordinary website: its data files are readable by
anyone who can reach it, so private reports need access control on the host.

## Credentials

- Connector fields marked `secret=True` are split off when a source is saved (`saveSource` in
  `data.ts`) and stored encrypted with Electron's `safeStorage` (Windows DPAPI), at
  `%APPDATA%\PawpawBI\credentials\<project id>\<source id>.bin`. They're never written to
  `sources/*.json` or anywhere in the project file.
- The renderer never receives saved secrets back, only which fields have one (`savedSecrets`).
  An empty secret field in the form means "keep the saved value".
- Secrets reach a connector job only through its stdin, never its command line (which other
  processes can read).
- Opening a shared project on another computer shows the data but asks for credentials again
  before refreshing.
- If secure storage is unavailable, saving secrets fails rather than falling back to plain text.

**Rules:** never log a job's settings or include secrets in error messages. Any new secret
must be a `secret=True` field, not a regular one.

## The renderer

- Electron defaults are kept: context isolation on, Node integration off, sandboxed renderer.
- `window.api` exposes specific operations, not general ones. There is no "read any file" or
  "run any command". File paths only enter through the native file picker or a connector's
  settings, and reopening from the recent list accepts only paths already in that list.
- Links that try to open a new window are sent to the user's browser instead (`main.ts`).
- The renderer makes no web requests; they're blocked (see The report).
- Vue templates use text interpolation, which escapes HTML. Don't use `v-html` with data from
  projects, sources or the network.
- Electron fuses (`forge.config.mts`) disable running the app as plain Node, Node options and
  inspector arguments, and enforce ASAR integrity in packaged builds.

## Downloads and dependencies

- **Python runtime:** pinned release and SHA-256 checksum per platform in
  `scripts/setup-python.mjs`. A mismatch aborts setup.
- **Python packages:** exact pins in `requirements.txt` and connector `packages`, plus
  `constraints.txt` locking every transitive version.
- **npm packages:** `package-lock.json`.
- **Policy:** every version must have been public for at least 14 days before we adopt it, so
  that compromised releases are usually caught and pulled first.
- **Vendored connectors:** copied from a pinned commit (`python/sidecar/verified_sources/README.md`)
  and not modified, so they can be diffed against upstream.
- **Telemetry:** dlt's anonymous usage telemetry is turned off (`RUNTIME__DLTHUB_TELEMETRY=false`).

**Known gap:** packages installed into connector environments are pinned at the top level, but
their own dependencies aren't locked per connector; see [TODO.md](../TODO.md).

## Releases

Not signed yet: Windows will show SmartScreen warnings. See the code-signing item in
[TODO.md](../TODO.md) and the release guide in [maintenance.md](maintenance.md). Everything
shipped, including bundled `.exe` and `.dll` files, should be signed.
